package docker

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"io"
	"testing"
)

func writeDockerStreamFrame(buf *bytes.Buffer, stream byte, payload []byte) {
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	buf.Write(header)
	buf.Write(payload)
}

func TestDockerWriteFileCommandPassesPathAsArgv(t *testing.T) {
	path := "/tmp/a'; touch /tmp/pwned; echo '"
	cmd := dockerWriteFileCommand(path)

	if len(cmd) != 5 {
		t.Fatalf("unexpected command length: %d", len(cmd))
	}
	if cmd[0] != "sh" {
		t.Fatalf("expected sh command, got %q", cmd[0])
	}
	if cmd[1] != "-c" {
		t.Fatalf("expected shell command flag, got %q", cmd[1])
	}
	if cmd[2] != "cat > \"$1\"" {
		t.Fatalf("unexpected shell command: %q", cmd[2])
	}
	if cmd[3] != "sh" {
		t.Fatalf("expected argv[0] placeholder, got %q", cmd[3])
	}
	if cmd[4] != path {
		t.Fatalf("expected path as argv data, got %q", cmd[4])
	}
}

func TestSplitDockerExecOutputKeepsShortRawStdout(t *testing.T) {
	stdout, stderr := splitDockerExecOutput([]byte("hello"))

	if string(stdout) != "hello" {
		t.Fatalf("stdout = %q, expected %q", string(stdout), "hello")
	}
	if len(stderr) != 0 {
		t.Fatalf("expected empty stderr, got %q", string(stderr))
	}
}

func TestSplitDockerExecOutputDemuxesDockerStdoutAndStderr(t *testing.T) {
	var raw bytes.Buffer
	writeDockerStreamFrame(&raw, 1, []byte("hello"))
	writeDockerStreamFrame(&raw, 2, []byte("warn"))

	stdout, stderr := splitDockerExecOutput(raw.Bytes())

	if string(stdout) != "hello" {
		t.Fatalf("stdout = %q, expected %q", string(stdout), "hello")
	}
	if string(stderr) != "warn" {
		t.Fatalf("stderr = %q, expected %q", string(stderr), "warn")
	}
}

func TestReadSingleRegularFileFromTarPreservesBinaryBytes(t *testing.T) {
	payload := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	if err := tw.WriteHeader(&tar.Header{Name: "image.jpg", Mode: 0o644, Size: int64(len(payload))}); err != nil {
		t.Fatalf("WriteHeader returned error: %v", err)
	}
	if _, err := tw.Write(payload); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	got, err := readSingleRegularFileFromTar(bytes.NewReader(archive.Bytes()), 1024)
	if err != nil {
		t.Fatalf("readSingleRegularFileFromTar returned error: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload = %x, expected %x", got, payload)
	}
}

func TestReadSingleRegularFileFromTarHonorsMaxBytes(t *testing.T) {
	payload := []byte("abcdef")
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	if err := tw.WriteHeader(&tar.Header{Name: "data.bin", Mode: 0o644, Size: int64(len(payload))}); err != nil {
		t.Fatalf("WriteHeader returned error: %v", err)
	}
	if _, err := tw.Write(payload); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	got, err := readSingleRegularFileFromTar(bytes.NewReader(archive.Bytes()), 3)
	if err != nil {
		t.Fatalf("readSingleRegularFileFromTar returned error: %v", err)
	}
	if string(got) != "abc" {
		t.Fatalf("payload = %q, expected %q", string(got), "abc")
	}
}

func TestGzipTarArchivePreservesBinaryTarStream(t *testing.T) {
	raw := []byte{0x00, 0xff, 0x8b, 0x80, 't', 'a', 'r', 0x00}
	compressed, err := gzipTarArchive(bytes.NewReader(raw), 1024)
	if err != nil {
		t.Fatalf("gzipTarArchive returned error: %v", err)
	}
	if len(compressed) < 2 || compressed[0] != 0x1f || compressed[1] != 0x8b {
		t.Fatalf("archive does not have gzip magic bytes: %x", compressed)
	}

	zr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("gzip.NewReader returned error: %v", err)
	}
	decompressed, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("io.ReadAll returned error: %v", err)
	}
	if err := zr.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if !bytes.Equal(decompressed, raw) {
		t.Fatalf("payload = %x, expected %x", decompressed, raw)
	}
}

func TestGzipTarArchiveHonorsCompressedSizeLimit(t *testing.T) {
	if _, err := gzipTarArchive(bytes.NewReader(bytes.Repeat([]byte{0xff}, 1024)), 8); err == nil {
		t.Fatal("expected gzipTarArchive to reject an oversized compressed archive")
	}
}

func TestDockerWriteFileChunkCommandUsesAlignedSeek(t *testing.T) {
	cmd, err := dockerWriteFileChunkCommand("/tmp/.gateway-upload-abc.tmp", 2*dockerFileUploadBlockBytes)
	if err != nil {
		t.Fatalf("dockerWriteFileChunkCommand returned error: %v", err)
	}
	expected := []string{"dd", "of=/tmp/.gateway-upload-abc.tmp", "bs=65536", "seek=2", "conv=notrunc"}
	if len(cmd) != len(expected) {
		t.Fatalf("unexpected command length: %d", len(cmd))
	}
	for i := range expected {
		if cmd[i] != expected[i] {
			t.Fatalf("cmd[%d] = %q, expected %q", i, cmd[i], expected[i])
		}
	}
}

func TestDockerWriteFileChunkCommandRejectsUnalignedOffset(t *testing.T) {
	if _, err := dockerWriteFileChunkCommand("/tmp/.gateway-upload-abc.tmp", 1); err == nil {
		t.Fatal("expected unaligned offset to fail")
	}
}

func TestValidatePathAllowsShellMetacharactersAsPlainPathData(t *testing.T) {
	paths := []string{
		"/tmp/a'; touch /tmp/pwned; echo '",
		"/tmp/$(touch /tmp/pwned)",
		"/tmp/a;touch /tmp/pwned",
		"/tmp/a\nb",
	}

	for _, path := range paths {
		if err := validatePath(path); err != nil {
			t.Fatalf("validatePath(%q) returned error: %v", path, err)
		}
	}
}

func TestVolumeTargetPathKeepsPathsInsideMountedVolume(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{input: "/", expected: "/volume"},
		{input: "/file.txt", expected: "/volume/file.txt"},
		{input: "/nested/file.txt", expected: "/volume/nested/file.txt"},
	}

	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			got, err := volumeTargetPath(tc.input)
			if err != nil {
				t.Fatalf("volumeTargetPath(%q) returned error: %v", tc.input, err)
			}
			if got != tc.expected {
				t.Fatalf("volumeTargetPath(%q) = %q, expected %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestVolumeTargetPathRejectsParentTraversal(t *testing.T) {
	for _, path := range []string{"/../file.txt", "/nested/../file.txt", "/../../node-file.txt"} {
		t.Run(path, func(t *testing.T) {
			if _, err := volumeTargetPath(path); err == nil {
				t.Fatalf("expected volumeTargetPath(%q) to reject parent traversal", path)
			}
		})
	}
}

func TestValidatePathAllowsDotDotInsideFilename(t *testing.T) {
	if err := validatePath("/tmp/file..txt"); err != nil {
		t.Fatalf("validatePath rejected a plain filename containing dots: %v", err)
	}
}

func TestMutableVolumeTargetPathRejectsRoot(t *testing.T) {
	if _, err := mutableVolumeTargetPath("/"); err == nil {
		t.Fatal("expected mutableVolumeTargetPath to reject root")
	}
}

func TestUploadTempPathRejectsUnsafeUploadIDs(t *testing.T) {
	for _, uploadID := range []string{"../escape", "bad/id", "bad id", "short"} {
		if _, _, err := uploadTempPath(uploadID, "/tmp/file"); err == nil {
			t.Fatalf("expected uploadTempPath to reject %q", uploadID)
		}
	}
}

func TestUploadTempPathUsesTargetParent(t *testing.T) {
	tempPath, cleanTarget, err := uploadTempPath("upload_123456", "/tmp/folder/file.txt")
	if err != nil {
		t.Fatalf("uploadTempPath returned error: %v", err)
	}
	if cleanTarget != "/tmp/folder/file.txt" {
		t.Fatalf("unexpected clean target: %q", cleanTarget)
	}
	if tempPath != "/tmp/folder/.gateway-upload-upload_123456.tmp" {
		t.Fatalf("unexpected temp path: %q", tempPath)
	}
}

func TestVolumeUploadTempPathUsesMappedTargetParent(t *testing.T) {
	tempPath, cleanTarget, err := volumeUploadTempPath("upload_123456", "/folder/file.txt")
	if err != nil {
		t.Fatalf("volumeUploadTempPath returned error: %v", err)
	}
	if cleanTarget != "/volume/folder/file.txt" {
		t.Fatalf("unexpected clean target: %q", cleanTarget)
	}
	if tempPath != "/volume/folder/.gateway-upload-upload_123456.tmp" {
		t.Fatalf("unexpected temp path: %q", tempPath)
	}
}

func TestVolumeUploadTempPathRejectsParentTraversal(t *testing.T) {
	if _, _, err := volumeUploadTempPath("upload_123456", "/../file.txt"); err == nil {
		t.Fatal("expected volumeUploadTempPath to reject parent traversal")
	}
}

func TestValidateMovePathsRejectsUnsafeMoves(t *testing.T) {
	cases := []struct {
		name string
		from string
		to   string
	}{
		{name: "root source", from: "/", to: "/tmp/root"},
		{name: "root target", from: "/tmp/file", to: "/"},
		{name: "same path", from: "/tmp/file", to: "/tmp/file"},
		{name: "descendant target", from: "/tmp/folder", to: "/tmp/folder/child"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := validateMovePaths(tc.from, tc.to); err == nil {
				t.Fatalf("expected validateMovePaths(%q, %q) to fail", tc.from, tc.to)
			}
		})
	}
}

func TestValidateMovePathsCleansSafeMoves(t *testing.T) {
	from, to, err := validateMovePaths("/tmp/source/.", "/var/target")
	if err != nil {
		t.Fatalf("validateMovePaths returned error: %v", err)
	}
	if from != "/tmp/source" || to != "/var/target" {
		t.Fatalf("unexpected cleaned paths: %q -> %q", from, to)
	}
}
