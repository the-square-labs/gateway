package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"strings"

	"github.com/distribution/reference"
	"github.com/moby/moby/client"
)

func (c *Client) ContainerName(ctx context.Context, containerID string) (string, error) {
	result, err := c.cli.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect container: %w", err)
	}
	name := strings.TrimPrefix(result.Container.Name, "/")
	if name == "" {
		name = result.Container.ID[:12]
	}
	return name, nil
}

// resolveRegistryAuth determines the registry auth string for the given image
// reference using the provided credentials map (registry URL -> base64 auth).
func resolveRegistryAuth(imageRef string, registryCreds map[string]string) string {
	if len(registryCreds) == 0 {
		return ""
	}
	named, err := reference.ParseNormalizedNamed(imageRef)
	if err != nil {
		return ""
	}
	domain := reference.Domain(named)
	if auth, ok := registryCreds[domain]; ok {
		return auth
	}
	return ""
}

// parseDockerLogs reads Docker multiplexed log output and strips the
// 8-byte header from each frame. Each frame has:
//
//	[1 byte stream type][3 bytes padding][4 bytes big-endian size][payload]
func parseDockerLogs(reader io.Reader) ([]string, error) {
	return parseDockerLogsBounded(reader, 0, maxDockerLogReadBytes)
}

func parseDockerLogsBounded(reader io.Reader, maxLines int, maxBytes int64) ([]string, error) {
	var lines []string
	header := make([]byte, 8)
	var readBytes int64

	for {
		_, err := io.ReadFull(reader, header)
		if err == io.EOF {
			break
		}
		if err != nil {
			// If we get unexpected EOF, the stream might be from a TTY container
			// which doesn't use multiplexed format. Fall back to line-based reading.
			break
		}

		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		readBytes += int64(size)
		if maxBytes > 0 && readBytes > maxBytes {
			return nil, errDockerLogsTooLarge
		}
		if size > maxDockerLogLineBytes {
			return nil, fmt.Errorf("docker log frame exceeds safety limit: %d bytes", size)
		}

		payload := make([]byte, size)
		_, err = io.ReadFull(reader, payload)
		if err != nil {
			break
		}

		// Split payload into lines (a frame may contain multiple lines)
		scanner := bufio.NewScanner(strings.NewReader(string(payload)))
		scanner.Buffer(make([]byte, 0, 64*1024), maxDockerLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				lines = append(lines, line)
				if maxLines > 0 && len(lines) > maxLines {
					copy(lines, lines[len(lines)-maxLines:])
					lines = lines[:maxLines]
				}
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("scan docker logs: %w", err)
		}
	}

	return lines, nil
}
