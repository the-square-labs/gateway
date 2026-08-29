package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"io"
	"strings"
)

func (p *DockerPlugin) handleLogsCommand(cmd *pb.DockerLogsCommand, result *pb.CommandResult) {
	ctx := context.Background()
	if p.sessionCtx != nil {
		ctx = p.sessionCtx
	}

	tail := int(cmd.TailLines)
	if tail <= 0 && !cmd.Follow {
		tail = 100
	}

	// If follow mode and we have a writer, start streaming
	if cmd.Follow && p.writer != nil {
		// Cancel any existing stream for this container
		p.logStreamMu.Lock()
		if cancel, ok := p.logStreamCancel[cmd.ContainerId]; ok {
			cancel()
			delete(p.logStreamCancel, cmd.ContainerId)
		}
		p.logStreamMu.Unlock()

		streamCtx, streamCancel := context.WithCancel(ctx)

		reader, err := p.client.ContainerLogsFollow(streamCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since)
		if err != nil {
			streamCancel()
			result.Success = false
			result.Error = err.Error()
			return
		}

		// Track the cancel function for cleanup
		p.logStreamMu.Lock()
		p.logStreamCancel[cmd.ContainerId] = streamCancel
		p.logStreamMu.Unlock()

		// Start streaming goroutine
		go p.streamLogs(streamCtx, streamCancel, cmd.ContainerId, reader)

		// Return immediately acknowledging the stream started
		data, _ := json.Marshal(map[string]bool{"streaming": true})
		result.Detail = string(data)
		return
	}

	// Non-follow mode: fetch logs once
	readCtx, cancel := context.WithTimeout(ctx, dockerLogsCommandTimeout)
	defer cancel()
	lines, err := p.client.ContainerLogs(readCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since, cmd.Until)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}

	data, err := json.Marshal(lines)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("marshal logs: %v", err)
		return
	}
	result.Detail = string(data)
}

// streamLogs reads from a Docker log follow stream and sends chunks back
// via the gRPC stream writer as CommandResult messages.
func (p *DockerPlugin) streamLogs(ctx context.Context, cancel context.CancelFunc, containerID string, reader io.ReadCloser) {
	defer func() {
		reader.Close()
		cancel()
		p.logStreamMu.Lock()
		delete(p.logStreamCancel, containerID)
		p.logStreamMu.Unlock()
		p.logger.Info("log stream ended", "container", containerID)
	}()

	header := make([]byte, 8)
	buf := make([]byte, 0, 16384)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Read Docker multiplexed log header (8 bytes)
		_, err := io.ReadFull(reader, header)
		if err != nil {
			// Stream ended (container stopped, context cancelled, etc.)
			// Send end-of-stream notification
			if p.writer != nil {
				endMsg, _ := json.Marshal(map[string]interface{}{
					"type":        "log_stream",
					"containerId": containerID,
					"lines":       []string{},
					"ended":       true,
				})
				p.writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_CommandResult{
						CommandResult: &pb.CommandResult{
							CommandId: "log_stream:" + containerID,
							Success:   true,
							Detail:    string(endMsg),
						},
					},
				})
			}
			return
		}

		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		if size > maxDockerLogLineBytes {
			p.logger.Warn("log stream frame exceeds safety limit", "container", containerID, "bytes", size)
			return
		}

		// Read the payload
		if cap(buf) < int(size) {
			buf = make([]byte, size)
		} else {
			buf = buf[:size]
		}
		_, err = io.ReadFull(reader, buf)
		if err != nil {
			return
		}

		// Parse payload into lines
		var lines []string
		scanner := bufio.NewScanner(strings.NewReader(string(buf)))
		scanner.Buffer(make([]byte, 0, 64*1024), maxDockerLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				lines = append(lines, line)
			}
		}
		if err := scanner.Err(); err != nil {
			p.logger.Warn("log stream scanner failed", "container", containerID, "error", err)
			return
		}

		if len(lines) == 0 {
			continue
		}

		// Send lines as a CommandResult with log_stream type
		streamMsg, _ := json.Marshal(map[string]interface{}{
			"type":        "log_stream",
			"containerId": containerID,
			"lines":       lines,
		})

		if p.writer != nil {
			if err := p.writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_CommandResult{
					CommandResult: &pb.CommandResult{
						CommandId: "log_stream:" + containerID,
						Success:   true,
						Detail:    string(streamMsg),
					},
				},
			}); err != nil {
				p.logger.Debug("log stream send failed", "container", containerID, "error", err)
				return
			}
		}
	}
}

// stopLogStream cancels a running log stream for the given container.
func (p *DockerPlugin) stopLogStream(containerID string) {
	p.logStreamMu.Lock()
	if cancel, ok := p.logStreamCancel[containerID]; ok {
		cancel()
		delete(p.logStreamCancel, containerID)
	}
	p.logStreamMu.Unlock()
}

// handleConfigPush processes a config push from the gateway, updating the
// allowlist and storing registry credentials.
