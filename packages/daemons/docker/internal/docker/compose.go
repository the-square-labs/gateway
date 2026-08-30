package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

const (
	composeCapability                 = "docker_compose_v1"
	composeOperationCacheLimit        = 256
	composeSidecarInitializationLimit = 5 * time.Second
	composeSidecarPullLimit           = 5 * time.Minute
	composeErrorDetailLimit           = 4 * 1024
)

var (
	composeProjectNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	composeOpaqueIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	composeDigestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	composeVolumeNamePattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	composeEnvironmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type composeRequest struct {
	action              string
	operationID         string
	projectID           string
	projectName         string
	revisionID          string
	configDigest        string
	composeYAML         []byte
	normalizedModelJSON string
	variables           map[string]string
	secrets             map[string]string
	removeOrphans       bool
	volumeNames         []string
}

type composeOperation struct {
	fingerprint string
	cancel      context.CancelFunc
	done        chan struct{}
	result      composeOperationResult
}

type composeOperationResult struct {
	fingerprint string
	detail      string
	err         error
}

type composeSidecar interface {
	run(context.Context, composeRequest) error
	cancelAll()
}

type composeExecutor struct {
	sidecar composeSidecar
	timeout time.Duration
	logger  *slog.Logger

	mu             sync.Mutex
	active         map[string]*composeOperation
	completed      map[string]composeOperationResult
	completedOrder []string
}

func newComposeExecutor(cfg *config.Config, dockerClient *Client, logger *slog.Logger) (*composeExecutor, error) {
	if cfg.Docker.Mode == "databases" {
		return nil, errors.New("database profile does not support docker compose")
	}
	if cfg.Docker.Compose.SidecarImage == "" {
		return nil, errors.New("compose sidecar image is not configured")
	}
	availabilityCtx, cancel := context.WithTimeout(context.Background(), composeSidecarInitializationLimit)
	_, inspectErr := dockerClient.cli.ImageInspect(availabilityCtx, cfg.Docker.Compose.SidecarImage)
	cancel()
	if inspectErr != nil {
		pullCtx, pullCancel := context.WithTimeout(context.Background(), composeSidecarPullLimit)
		stream, pullErr := dockerClient.cli.ImagePull(pullCtx, cfg.Docker.Compose.SidecarImage, client.ImagePullOptions{})
		if pullErr == nil {
			_, pullErr = io.Copy(io.Discard, stream)
			_ = stream.Close()
		}
		pullCancel()
		if pullErr != nil {
			return nil, errors.New("pull configured compose sidecar image")
		}
		verifyCtx, verifyCancel := context.WithTimeout(context.Background(), composeSidecarInitializationLimit)
		_, verifyErr := dockerClient.cli.ImageInspect(verifyCtx, cfg.Docker.Compose.SidecarImage)
		verifyCancel()
		if verifyErr != nil {
			return nil, errors.New("configured compose sidecar image is unavailable after pull")
		}
	}
	sidecar, err := newDockerComposeSidecar(dockerClient, cfg.Docker.Socket, cfg.Docker.Compose.SidecarImage)
	if err != nil {
		return nil, err
	}
	return &composeExecutor{
		sidecar:   sidecar,
		timeout:   time.Duration(cfg.Docker.Compose.CommandTimeoutSeconds) * time.Second,
		logger:    logger,
		active:    make(map[string]*composeOperation),
		completed: make(map[string]composeOperationResult),
	}, nil
}

func (p *DockerPlugin) handleComposeCommand(cmd *pb.DockerComposeCommand, result *pb.CommandResult) {
	if p.composeExecutor == nil {
		result.Success = false
		result.Error = "docker compose executor is unavailable"
		return
	}
	detail, err := p.composeExecutor.handle(cmd)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}

func (e *composeExecutor) handle(cmd *pb.DockerComposeCommand) (string, error) {
	request, err := validateComposeCommand(cmd)
	if err != nil {
		return "", err
	}
	if request.action == "cancel" {
		return "", e.cancel(request)
	}

	fingerprint := composeRequestFingerprint(request)
	cacheKey := composeOperationKey(request.projectID, request.operationID)
	e.mu.Lock()
	if completed, ok := e.completed[cacheKey]; ok {
		e.mu.Unlock()
		if completed.fingerprint != fingerprint {
			return "", errors.New("docker compose operation id conflicts with a prior payload")
		}
		return completed.detail, completed.err
	}
	if active, ok := e.active[request.projectID]; ok {
		if active.fingerprint != fingerprint {
			e.mu.Unlock()
			return "", errors.New("a conflicting docker compose operation is already active for this project")
		}
		done := active.done
		e.mu.Unlock()
		<-done
		return active.result.detail, active.result.err
	}
	ctx, cancel := context.WithTimeout(context.Background(), e.timeout)
	operation := &composeOperation{fingerprint: fingerprint, cancel: cancel, done: make(chan struct{})}
	e.active[request.projectID] = operation
	e.mu.Unlock()

	err = e.sidecar.run(ctx, request)
	cancel()
	if err != nil {
		err = redactComposeExecutionError(err)
	}
	result := composeOperationResult{fingerprint: fingerprint, err: err}

	e.mu.Lock()
	operation.result = result
	delete(e.active, request.projectID)
	e.completed[cacheKey] = result
	e.completedOrder = append(e.completedOrder, cacheKey)
	if len(e.completedOrder) > composeOperationCacheLimit {
		oldest := e.completedOrder[0]
		e.completedOrder = e.completedOrder[1:]
		delete(e.completed, oldest)
	}
	close(operation.done)
	e.mu.Unlock()
	return result.detail, result.err
}

func (e *composeExecutor) cancel(request composeRequest) error {
	e.mu.Lock()
	operation, ok := e.active[request.projectID]
	if !ok {
		e.mu.Unlock()
		return errors.New("no active docker compose operation matches this project")
	}
	if operation.fingerprint == "" || !strings.Contains(operation.fingerprint, "\x00"+request.operationID+"\x00") {
		e.mu.Unlock()
		return errors.New("no active docker compose operation matches this operation id")
	}
	operation.cancel()
	done := operation.done
	e.mu.Unlock()
	<-done
	return nil
}

func (e *composeExecutor) cancelAll() {
	e.mu.Lock()
	for _, operation := range e.active {
		operation.cancel()
	}
	e.mu.Unlock()
	e.sidecar.cancelAll()
}

func validateComposeCommand(cmd *pb.DockerComposeCommand) (composeRequest, error) {
	if cmd == nil {
		return composeRequest{}, errors.New("docker compose command is required")
	}
	request := composeRequest{
		action: cmd.Action, operationID: cmd.OperationId, projectID: cmd.ProjectId, projectName: cmd.ProjectName,
		revisionID: cmd.RevisionId, configDigest: cmd.ConfigDigest, composeYAML: cmd.ComposeYaml,
		normalizedModelJSON: cmd.NormalizedModelJson, variables: cmd.Variables, secrets: cmd.Secrets,
		removeOrphans: cmd.RemoveOrphans, volumeNames: cmd.VolumeNames,
	}
	if !isComposeAction(request.action) {
		return composeRequest{}, errors.New("unsupported docker compose action")
	}
	if !composeOpaqueIDPattern.MatchString(request.operationID) || !composeOpaqueIDPattern.MatchString(request.projectID) {
		return composeRequest{}, errors.New("docker compose operation_id and project_id are required")
	}
	if !composeProjectNamePattern.MatchString(request.projectName) {
		return composeRequest{}, errors.New("docker compose project_name is invalid")
	}
	if request.action == "cancel" {
		if request.removeOrphans || len(request.volumeNames) != 0 || len(request.composeYAML) != 0 || request.normalizedModelJSON != "" || len(request.variables) != 0 || len(request.secrets) != 0 {
			return composeRequest{}, errors.New("cancel does not accept docker compose configuration")
		}
		return request, nil
	}
	if request.removeOrphans && request.action != "apply" && request.action != "pull_apply" && request.action != "down" {
		return composeRequest{}, errors.New("remove_orphans is not allowed for this docker compose action")
	}
	if request.action == "delete_volumes" {
		if len(request.volumeNames) == 0 {
			return composeRequest{}, errors.New("delete_volumes requires explicit volume_names")
		}
		seen := make(map[string]struct{}, len(request.volumeNames))
		for _, name := range request.volumeNames {
			if !composeVolumeNamePattern.MatchString(name) {
				return composeRequest{}, errors.New("docker compose volume name is invalid")
			}
			if _, exists := seen[name]; exists {
				return composeRequest{}, errors.New("docker compose volume_names must be unique")
			}
			seen[name] = struct{}{}
		}
		return request, nil
	}
	if request.action != "delete_volumes" {
		if !composeOpaqueIDPattern.MatchString(request.revisionID) || !composeDigestPattern.MatchString(request.configDigest) {
			return composeRequest{}, errors.New("docker compose lifecycle action requires revision_id and a sha256 config_digest")
		}
		if len(request.composeYAML) == 0 || len(request.composeYAML) > 1024*1024 {
			return composeRequest{}, errors.New("docker compose lifecycle action requires compose_yaml up to 1 MiB")
		}
		if request.normalizedModelJSON == "" || len(request.normalizedModelJSON) > 1024*1024 || !json.Valid([]byte(request.normalizedModelJSON)) {
			return composeRequest{}, errors.New("docker compose lifecycle action requires valid normalized_model_json")
		}
		if err := validateComposeEnvironment(request.variables, request.secrets); err != nil {
			return composeRequest{}, err
		}
		if err := validateAndInjectComposeYAML(&request); err != nil {
			return composeRequest{}, err
		}
		return request, nil
	}
	return composeRequest{}, errors.New("unsupported docker compose action")
}

func isComposeAction(action string) bool {
	switch action {
	case "apply", "pull_apply", "start", "stop", "restart", "down", "delete_volumes", "cancel":
		return true
	default:
		return false
	}
}

func validateComposeEnvironment(variables, secrets map[string]string) error {
	for key, value := range variables {
		if !composeEnvironmentPattern.MatchString(key) || len(value) > 64*1024 {
			return errors.New("docker compose variable binding is invalid")
		}
		if _, conflicts := secrets[key]; conflicts {
			return errors.New("docker compose variable and secret names must not overlap")
		}
	}
	for key, value := range secrets {
		if !composeEnvironmentPattern.MatchString(key) || len(value) > 64*1024 {
			return errors.New("docker compose secret binding is invalid")
		}
	}
	return nil
}

func composeRequestFingerprint(request composeRequest) string {
	hash := sha256.New()
	_, _ = hash.Write(request.composeYAML)
	_, _ = hash.Write([]byte("\x00"))
	_, _ = hash.Write([]byte(request.normalizedModelJSON))
	_, _ = hash.Write([]byte("\x00"))
	_, _ = hash.Write([]byte(strings.Join(sortedComposeBindings(request.variables), "\x00")))
	_, _ = hash.Write([]byte("\x00"))
	_, _ = hash.Write([]byte(strings.Join(sortedComposeBindings(request.secrets), "\x00")))
	_, _ = hash.Write([]byte("\x00"))
	_, _ = hash.Write([]byte(strings.Join(request.volumeNames, "\x00")))
	return strings.Join([]string{request.projectID, request.operationID, request.action, request.revisionID, request.configDigest, hex.EncodeToString(hash.Sum(nil))}, "\x00")
}

func sortedComposeBindings(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

func composeOperationKey(projectID, operationID string) string {
	return projectID + "\x00" + operationID
}

type composeSidecarCommandError struct {
	detail string
}

func (e *composeSidecarCommandError) Error() string { return e.detail }

func redactComposeExecutionError(err error) error {
	if errors.Is(err, context.Canceled) {
		return errors.New("docker compose operation canceled")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("docker compose operation timed out")
	}
	var commandError *composeSidecarCommandError
	if errors.As(err, &commandError) {
		detail := safeComposeErrorDetail(commandError.detail)
		if detail != "" {
			return errors.New(detail)
		}
	}
	return errors.New("docker compose operation failed")
}

func safeComposeErrorDetail(detail string) string {
	normalized := strings.ToLower(strings.Join(strings.Fields(detail), " "))
	switch {
	case strings.Contains(normalized, "port is already allocated"),
		strings.Contains(normalized, "address already in use"),
		strings.Contains(normalized, "bind for"):
		return "Docker Compose could not publish a host port because it is already in use. Change the published port and create a new revision."
	case strings.Contains(normalized, "authentication required"),
		strings.Contains(normalized, "unauthorized"),
		strings.Contains(normalized, "pull access denied"),
		strings.Contains(normalized, "requested access to the resource is denied"):
		return "Docker Compose could not authenticate to an image registry. Verify the registry credentials and image access."
	case strings.Contains(normalized, "manifest unknown"),
		strings.Contains(normalized, "no matching manifest"),
		strings.Contains(normalized, "not found") && strings.Contains(normalized, "manifest"):
		return "Docker Compose could not find a configured image tag for this node architecture. Verify the image name and tag."
	case strings.Contains(normalized, "no such image"),
		strings.Contains(normalized, "image is missing locally"):
		return "A required image is not available on the Docker node. Run Pull & Apply or verify registry access."
	case strings.Contains(normalized, "declared as external") && strings.Contains(normalized, "network"):
		return "A required external Docker network was not found on the node. Create it or update the Compose configuration."
	case strings.Contains(normalized, "declared as external") && strings.Contains(normalized, "volume"):
		return "A required external Docker volume was not found on the node. Create it or update the Compose configuration."
	case strings.Contains(normalized, "invalid reference format"):
		return "A configured container image reference is invalid. Update the image name and create a new revision."
	case strings.Contains(normalized, "container name") && strings.Contains(normalized, "already in use"):
		return "A Compose container name is already in use on the Docker node. Rename or remove the conflicting container."
	default:
		return "docker compose operation failed"
	}
}

// dockerComposeSidecar runs a pre-provisioned digest-pinned image through the
// daemon's Engine client. User data is never passed as host paths or command
// arguments; the only bind mounts are a private staged directory and the
// configured daemon Unix socket.
type dockerComposeSidecar struct {
	client     *Client
	image      string
	socketPath string
}

func newDockerComposeSidecar(dockerClient *Client, socket, image string) (*dockerComposeSidecar, error) {
	if !strings.HasPrefix(socket, "unix://") {
		return nil, errors.New("compose sidecar requires a Unix Docker socket")
	}
	socketPath := strings.TrimPrefix(socket, "unix://")
	if socketPath == "" || !strings.HasPrefix(socketPath, "/") {
		return nil, errors.New("compose sidecar Docker socket is invalid")
	}
	return &dockerComposeSidecar{client: dockerClient, image: image, socketPath: socketPath}, nil
}

func (s *dockerComposeSidecar) run(ctx context.Context, request composeRequest) error {
	if request.action == "delete_volumes" {
		return s.deleteVolumes(ctx, request.projectName, request.volumeNames)
	}
	stage, cleanup, err := stageComposeInput(request)
	if err != nil {
		return err
	}
	defer cleanup()
	commands, err := composeSidecarCommands(request)
	if err != nil {
		return err
	}
	for _, command := range commands {
		if err := s.runCompose(ctx, request, stage, command[0], command[1:]...); err != nil {
			return err
		}
	}
	return nil
}

func composeSidecarCommands(request composeRequest) ([][]string, error) {
	switch request.action {
	case "apply":
		return [][]string{{"up", "--detach", "--no-build", "--pull", "never"}}, nil
	case "pull_apply":
		return [][]string{{"pull"}, {"up", "--detach", "--no-build", "--pull", "never"}}, nil
	case "start", "stop", "restart":
		return [][]string{{request.action}}, nil
	case "down":
		command := []string{"down"}
		if request.removeOrphans {
			command = append(command, "--remove-orphans")
		}
		return [][]string{command}, nil
	default:
		return nil, errors.New("unsupported compose sidecar action")
	}
}

func (s *dockerComposeSidecar) runCompose(ctx context.Context, request composeRequest, stage *composeStage, command string, args ...string) error {
	commandArgs := []string{"--project-name", request.projectName}
	if stage != nil {
		commandArgs = append(commandArgs, "--file", "/gateway-compose/compose.yaml")
	}
	commandArgs = append(commandArgs, command)
	commandArgs = append(commandArgs, args...)
	env := composeSidecarEnvironment(request)
	return s.client.runComposeSidecar(ctx, s.image, s.socketPath, stage, commandArgs, env)
}

func (s *dockerComposeSidecar) deleteVolumes(ctx context.Context, projectName string, names []string) error {
	for _, name := range names {
		volume, err := s.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
		if err != nil {
			return fmt.Errorf("inspect requested compose volume: %w", err)
		}
		if volume.Volume.Labels["com.docker.compose.project"] != projectName {
			return errors.New("requested volume is not owned by this docker compose project")
		}
	}
	for _, name := range names {
		if _, err := s.client.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil {
			return fmt.Errorf("remove requested compose volume: %w", err)
		}
	}
	return nil
}

func (s *dockerComposeSidecar) cancelAll() {}

func composeSidecarEnvironment(request composeRequest) []string {
	env := []string{"DOCKER_HOST=unix:///var/run/docker.sock"}
	keys := make([]string, 0, len(request.variables)+len(request.secrets))
	for key := range request.variables {
		keys = append(keys, key)
	}
	for key := range request.secrets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value, ok := request.variables[key]; ok {
			env = append(env, key+"="+value)
			continue
		}
		env = append(env, key+"="+request.secrets[key])
	}
	return env
}
