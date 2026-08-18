package pages

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyReleaseRejectsSymlinkedContentTree(t *testing.T) {
	t.Run("content directory", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		stageRelease(t, runtime)
		outsideDir := t.TempDir()
		outside := filepath.Join(outsideDir, "outside")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		outsideInfo, err := os.Stat(outsideDir)
		if err != nil {
			t.Fatal(err)
		}
		outsideMode := outsideInfo.Mode().Perm()
		content := runtime.releaseContentDir(deploymentID)
		if err := os.RemoveAll(content); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideDir, content); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.VerifyRelease(deploymentID, ""); err == nil {
			t.Fatal("accepted symlinked release content directory")
		}
		assertMode(t, outsideDir, outsideMode)
	})

	t.Run("descendant", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		stageRelease(t, runtime)
		outside := filepath.Join(t.TempDir(), "outside.js")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(runtime.releaseContentDir(deploymentID), "escape.js")
		if err := os.Symlink(outside, link); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.VerifyRelease(deploymentID, ""); err == nil {
			t.Fatal("accepted symlinked release descendant")
		}
		assertMode(t, outside, 0o600)
	})
}

func TestStoragePreflightRejectsSymlinkedRootAndUploads(t *testing.T) {
	t.Run("root", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		outside := t.TempDir()
		outsideInfo, err := os.Stat(outside)
		if err != nil {
			t.Fatal(err)
		}
		outsideMode := outsideInfo.Mode().Perm()
		if err := os.Symlink(outside, runtime.root); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.StoragePreflight(1); err == nil {
			t.Fatal("accepted symlinked Pages root")
		}
		assertMode(t, outside, outsideMode)
	})

	t.Run("uploads", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		if err := os.MkdirAll(runtime.root, publicDirectoryMode); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		outsideInfo, err := os.Stat(outside)
		if err != nil {
			t.Fatal(err)
		}
		outsideMode := outsideInfo.Mode().Perm()
		if err := os.Symlink(outside, runtime.uploadsDir()); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.StoragePreflight(1); err == nil {
			t.Fatal("accepted symlinked uploads directory")
		}
		assertMode(t, outside, outsideMode)
	})
}

func TestAppendUploadRejectsSymlinkedArchive(t *testing.T) {
	runtime, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	if err := runtime.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.tar.gz")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, runtime.uploadArchivePath(uploadID)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload(uploadID, 0, archive); err == nil {
		t.Fatal("accepted symlinked upload archive")
	}
	assertMode(t, outside, 0o600)
	content, err := os.ReadFile(outside)
	if err != nil || string(content) != "outside" {
		t.Fatalf("external archive changed: %q, %v", content, err)
	}
}

func TestStoragePreflightRejectsSymlinkedUploadArchive(t *testing.T) {
	runtime, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	if err := runtime.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.tar.gz")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, runtime.uploadArchivePath(uploadID)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.StoragePreflight(1); err == nil {
		t.Fatal("preflight accepted symlinked upload archive")
	}
	content, err := os.ReadFile(outside)
	if err != nil || string(content) != "outside" {
		t.Fatalf("external archive changed: %q, %v", content, err)
	}
}
