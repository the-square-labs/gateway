package docker

import (
	"bytes"
	"strconv"
)

// A connector replacement lets a tunnel go once it is idle between requests (retireConnectorUntil). A response that
// is still streaming is not idle, however long it pauses: stand rc.7 O-14 cut two SSE streams (an event every ~100 ms)
// because the 100 ms quiet rule matched the gap between two events. drainConn therefore follows the workload's
// HTTP/1.x response framing and publishes whether the current response is still in progress (midResponse). The head
// is parsed once per response; after that a read costs an integer subtract or a 5-byte suffix check, never a scan of
// the body.

// framing is where the workload's answer stands on a tunnel.
type framing uint8

const (
	// framingHead: between responses, the next bytes start a response head.
	framingHead framing = iota
	// framingLength: a body of a known length is being read (framingState.remaining bytes to go).
	framingLength
	// framingChunked: a chunked body is being read until its terminating chunk.
	framingChunked
	// framingUntilClose: the response ends with the connection (no length, an event stream, a head that does not
	// parse, or an upgraded connection): the tunnel counts as busy until it ends.
	framingUntilClose
)

const (
	// maxResponseHead bounds the bytes kept for a head that arrives in pieces; a longer one is treated as unparseable.
	maxResponseHead   = 8 << 10
	chunkedTerminator = "0\r\n\r\n"
)

// framingState is the response tracker of one drainConn. Only the goroutine that reads the workload touches it.
type framingState struct {
	mode      framing
	remaining int64
	// head holds the start of a response head that has not ended yet.
	head []byte
	// tail is the last bytes of a chunked body, so a terminator split across reads is still seen.
	tail [4]byte
}

// trackResponse follows the bytes read from the workload and updates midResponse. The status line is assumed to
// start a read in framingHead, as switchingProtocols does.
func (c *drainConn) trackResponse(data []byte) {
	if c.upgraded.Load() {
		return
	}
	state := &c.framing
	for len(data) > 0 {
		switch state.mode {
		case framingUntilClose:
			data = nil
		case framingLength:
			if int64(len(data)) < state.remaining {
				state.remaining -= int64(len(data))
				data = nil
				break
			}
			data = data[state.remaining:]
			state.mode, state.remaining = framingHead, 0
		case framingChunked:
			if chunkedEnded(state, data) {
				state.mode = framingHead
			}
			data = nil
		default:
			data = c.readHead(data)
		}
	}
	mid := state.mode != framingHead || len(state.head) > 0
	if c.midResponse.Load() != mid {
		c.midResponse.Store(mid)
	}
}

// chunkedEnded reports a chunked body whose terminating chunk ends this read. A terminator followed by more bytes
// (a pipelined next response in the same read) is not seen: the tunnel then stays busy, the safe direction.
func chunkedEnded(state *framingState, data []byte) bool {
	var ended bool
	if len(data) >= len(chunkedTerminator) {
		ended = string(data[len(data)-len(chunkedTerminator):]) == chunkedTerminator
	} else {
		joined := append(append(make([]byte, 0, len(state.tail)+len(data)), state.tail[:]...), data...)
		ended = string(joined[len(joined)-len(chunkedTerminator):]) == chunkedTerminator
	}
	if len(data) >= len(state.tail) {
		copy(state.tail[:], data[len(data)-len(state.tail):])
	} else {
		copy(state.tail[:], state.tail[len(data):])
		copy(state.tail[len(state.tail)-len(data):], data)
	}
	if ended {
		state.tail = [4]byte{}
	}
	return ended
}

// readHead consumes a response head from the front of data and returns the bytes after it. A head that does not end
// in this read is kept for the next one (midResponse stays true meanwhile).
func (c *drainConn) readHead(data []byte) []byte {
	state := &c.framing
	head := data
	if len(state.head) > 0 {
		head = append(state.head, data...)
	}
	if len(head) >= 7 && string(head[:7]) != "HTTP/1." {
		state.head, state.mode = nil, framingUntilClose
		return nil
	}
	end := bytes.Index(head, []byte("\r\n\r\n"))
	if end < 0 {
		if len(head) > maxResponseHead {
			state.head, state.mode = nil, framingUntilClose
			return nil
		}
		state.head = append(state.head[:0], head...)
		return nil
	}
	rest := head[end+4:]
	head = head[:end]
	state.head = nil
	if switchingProtocols(head) {
		c.upgraded.Store(true)
		state.mode = framingUntilClose
		return nil
	}
	status, ok := responseStatus(head)
	if !ok {
		state.mode = framingUntilClose
		return nil
	}
	switch {
	case status < 200:
		// Interim answer (100 Continue, 103 Early Hints): the real head follows.
		return rest
	}
	bodyless := c.headRequest.Swap(false) || status == 204 || status == 304
	if bodyless {
		return rest
	}
	length, chunked, stream, ok := responseBodyFraming(head)
	switch {
	case !ok || stream:
		state.mode = framingUntilClose
		return nil
	case chunked:
		state.mode, state.tail = framingChunked, [4]byte{}
		// The body may already be in this read (the whole response in one segment).
		if len(rest) > 0 && chunkedEnded(state, rest) {
			state.mode = framingHead
		}
		return nil
	case length == 0:
		return rest
	case length > 0:
		state.mode, state.remaining = framingLength, length
		return rest
	}
	state.mode = framingUntilClose
	return nil
}

// responseStatus reads the status code of a head that starts with "HTTP/1.x SSS".
func responseStatus(head []byte) (int, bool) {
	if len(head) < 12 || head[8] != ' ' {
		return 0, false
	}
	status, err := strconv.Atoi(string(head[9:12]))
	return status, err == nil && status >= 100
}

// responseBodyFraming reads how the body of a response with these headers ends: a length (-1 when none is given),
// chunked, or by the connection (an event stream). ok is false for a header that does not parse.
func responseBodyFraming(head []byte) (length int64, chunked, stream, ok bool) {
	length, ok = -1, true
	lines := head
	if newline := bytes.IndexByte(lines, '\n'); newline >= 0 {
		lines = lines[newline+1:]
	} else {
		lines = nil
	}
	for len(lines) > 0 {
		line := lines
		if newline := bytes.IndexByte(lines, '\n'); newline >= 0 {
			line, lines = lines[:newline], lines[newline+1:]
		} else {
			lines = nil
		}
		if value, found := headerValue(line, "content-length:"); found {
			parsed, err := strconv.ParseInt(string(value), 10, 64)
			if err != nil || parsed < 0 {
				return -1, false, false, false
			}
			length = parsed
		} else if value, found := headerValue(line, "transfer-encoding:"); found {
			chunked = chunked || headerHasToken(value, "chunked")
		} else if value, found := headerValue(line, "content-type:"); found {
			stream = len(value) >= 17 && bytes.EqualFold(value[:17], []byte("text/event-stream"))
		}
	}
	return length, chunked, stream, ok
}

// headerValue returns the trimmed value of a header line with the given lower-case name (with its colon).
func headerValue(line []byte, name string) ([]byte, bool) {
	if len(line) < len(name) || !bytes.EqualFold(line[:len(name)], []byte(name)) {
		return nil, false
	}
	return bytes.TrimSpace(line[len(name):]), true
}

func headerHasToken(value []byte, word string) bool {
	return bytes.Contains(bytes.ToLower(value), []byte(word))
}
