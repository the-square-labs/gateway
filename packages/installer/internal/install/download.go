package install

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/installer/internal/config"
)

type release struct {
	TagName string `json:"tag_name"`
}

func daemonRelease(n config.Node) (name, tag string, err error) {
	suffix := string(n.Type)
	name = suffix + "-daemon"
	if n.Type == config.NodeDatabases {
		name, suffix = "docker-daemon", "docker"
	}
	if n.Type == config.NodeNginx {
		name, suffix = "nginx-daemon", "nginx"
	}
	if n.Type == config.NodeMonitoring {
		name, suffix = "monitoring-daemon", "monitoring"
	}
	if n.Version == "latest" || n.Version == "nightly" {
		return name, "", nil
	}
	if daemonRCTag(n.Version, "-"+suffix) {
		if strings.HasPrefix(n.Version, "v") {
			return name, n.Version, nil
		}
		return name, "v" + n.Version, nil
	}
	version := strings.TrimSuffix(n.Version, "-"+suffix)
	if !strings.HasPrefix(version, "v") {
		version = "v" + version
	}
	return name, version + "-" + suffix, nil
}

func resolveDaemonTag(client *http.Client, n config.Node) (string, error) {
	_, tag, err := daemonRelease(n)
	if err != nil || tag != "" {
		return tag, err
	}
	project := url.PathEscape(n.GitLabProject)
	endpoint := strings.TrimRight(n.GitLabURL, "/") + "/api/v4/projects/" + project + "/releases"
	response, err := client.Get(endpoint)
	if err != nil {
		return "", fmt.Errorf("list daemon releases: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("list daemon releases: %s", response.Status)
	}
	var releases []release
	if err := json.NewDecoder(response.Body).Decode(&releases); err != nil {
		return "", fmt.Errorf("decode daemon releases: %w", err)
	}
	suffix := daemonSuffix(n.Type)
	if n.Version == "nightly" {
		return latestDaemonRCTag(releases, suffix)
	}
	stableTag := regexp.MustCompile(`^v?\d+\.\d+\.\d+` + regexp.QuoteMeta(suffix) + `$`)
	for _, item := range releases {
		if stableTag.MatchString(item.TagName) {
			return item.TagName, nil
		}
	}
	return "", fmt.Errorf("no release found for %s node", n.Type)
}

func daemonSuffix(nodeType config.NodeType) string {
	if nodeType == config.NodeDatabases {
		return "-docker"
	}
	return "-" + string(nodeType)
}

type daemonRCVersion struct {
	major int
	minor int
	patch int
	rc    int
}

func latestDaemonRCTag(releases []release, suffix string) (string, error) {
	pattern := regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)` + regexp.QuoteMeta(suffix) + `-rc\.(\d+)$`)
	var latestTag string
	var latest daemonRCVersion
	for _, item := range releases {
		matches := pattern.FindStringSubmatch(item.TagName)
		if matches == nil {
			continue
		}
		candidate := daemonRCVersion{
			major: parseVersionPart(matches[1]),
			minor: parseVersionPart(matches[2]),
			patch: parseVersionPart(matches[3]),
			rc:    parseVersionPart(matches[4]),
		}
		if latestTag == "" || daemonRCNewer(candidate, latest) {
			latestTag = item.TagName
			latest = candidate
		}
	}
	if latestTag == "" {
		return "", fmt.Errorf("no release-candidate found for %s daemon", strings.TrimPrefix(suffix, "-"))
	}
	return latestTag, nil
}

func daemonRCTag(tag, suffix string) bool {
	pattern := regexp.MustCompile(`^v?\d+\.\d+\.\d+` + regexp.QuoteMeta(suffix) + `-rc\.\d+$`)
	return pattern.MatchString(tag)
}

func parseVersionPart(value string) int {
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func daemonRCNewer(left, right daemonRCVersion) bool {
	if left.major != right.major {
		return left.major > right.major
	}
	if left.minor != right.minor {
		return left.minor > right.minor
	}
	if left.patch != right.patch {
		return left.patch > right.patch
	}
	return left.rc > right.rc
}

func linuxArch() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("unsupported architecture: %s", runtime.GOARCH)
	}
}

func downloadAndVerify(client *http.Client, baseURL, asset, target string, progress io.Writer) error {
	checksums, err := get(client, baseURL+"/checksums.txt")
	if err != nil {
		return fmt.Errorf("download checksums: %w", err)
	}
	want := checksumFor(checksums, asset)
	if want == "" {
		return fmt.Errorf("no checksum found for %s", asset)
	}
	response, err := client.Get(baseURL + "/" + asset)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("download %s: %s", asset, response.Status)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	temporary := target + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	copyErr := copyWithProgress(file, response.Body, asset, response.ContentLength, progress)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	fmt.Fprintln(progress, "Verifying checksum...")
	actual, err := fileChecksum(temporary)
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if actual != want {
		_ = os.Remove(temporary)
		return fmt.Errorf("checksum verification failed for %s", asset)
	}
	if err := os.Chmod(temporary, 0755); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

func copyWithProgress(destination io.Writer, source io.Reader, asset string, total int64, output io.Writer) error {
	buffer := make([]byte, 64*1024)
	progress := newDownloadProgress(output, asset, total)
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			if _, writeErr := destination.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			progress.add(int64(read))
		}
		if readErr == io.EOF {
			progress.finish()
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

type downloadProgress struct {
	output     io.Writer
	asset      string
	total      int64
	downloaded int64
	startedAt  time.Time
	lastRender time.Time
}

func newDownloadProgress(output io.Writer, asset string, total int64) *downloadProgress {
	now := time.Now()
	return &downloadProgress{output: output, asset: asset, total: total, startedAt: now, lastRender: now}
}

func (p *downloadProgress) add(bytes int64) {
	p.downloaded += bytes
	if time.Since(p.lastRender) >= 150*time.Millisecond {
		p.render(false)
	}
}

func (p *downloadProgress) finish() {
	p.render(true)
	fmt.Fprintln(p.output)
}

func (p *downloadProgress) render(final bool) {
	elapsed := time.Since(p.startedAt)
	if elapsed < time.Millisecond {
		elapsed = time.Millisecond
	}
	rate := float64(p.downloaded) / elapsed.Seconds()
	message := fmt.Sprintf("\rDownloading %s: %s", p.asset, progressBytes(p.downloaded))
	if p.total > 0 {
		percent := int(float64(p.downloaded) * 100 / float64(p.total))
		if final {
			percent = 100
		}
		message += fmt.Sprintf(" / %s (%d%%)", progressBytes(p.total), percent)
	}
	fmt.Fprintf(p.output, "%s · %s/s", message, progressBytes(int64(rate)))
	p.lastRender = time.Now()
}

func progressBytes(bytes int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	value := float64(bytes)
	index := 0
	for value >= 1024 && index < len(units)-1 {
		value /= 1024
		index++
	}
	if index == 0 || value >= 10 {
		return fmt.Sprintf("%.0f %s", value, units[index])
	}
	return fmt.Sprintf("%.1f %s", value, units[index])
}

func get(client *http.Client, endpoint string) ([]byte, error) {
	response, err := client.Get(endpoint)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("%s", response.Status)
	}
	return io.ReadAll(response.Body)
}

func checksumFor(contents []byte, asset string) string {
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimPrefix(fields[1], "*") == asset {
			return strings.ToLower(fields[0])
		}
	}
	return ""
}

func fileChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
