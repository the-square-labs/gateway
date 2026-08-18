package pages

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeConfigStagesActivatesRollsBackAndRemovesBinding(t *testing.T) {
	runtime, _ := newRuntime(t)
	first := []byte(`{"apiUrl":"https://example.test","enabled":true}`)
	second := []byte(`{"apiUrl":"https://next.example.test"}`)
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, first); err != nil {
		t.Fatal(err)
	}
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2, second); err != nil {
		t.Fatal(err)
	}
	routeBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID)
	assertMode(t, runtime.root, publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.root, "runtime-configs"), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.root, "runtime-configs", "routes"), publicDirectoryMode)
	assertMode(t, routeBinding, publicDirectoryMode)
	assertMode(t, filepath.Join(routeBinding, "versions"), publicDirectoryMode)
	assertMode(t, filepath.Join(routeBinding, "versions", "1.js"), publicFileMode)
	assertMode(t, filepath.Join(routeBinding, "versions", "2.js"), publicFileMode)
	path, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2)
	if err != nil {
		t.Fatal(err)
	}
	linkInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("runtime config current path is not a symlink: %s", path)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "window.runtime.config = JSON.parse(") || !strings.Contains(string(content), `next.example.test`) {
		t.Fatalf("unexpected runtime JavaScript: %s", content)
	}
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runtime.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(routeBinding, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(routeBinding, "versions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(routeBinding, "versions", "1.js"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err != nil {
		t.Fatal(err)
	}
	assertMode(t, runtime.root, publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.root, "runtime-configs"), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.root, "runtime-configs", "routes"), publicDirectoryMode)
	assertMode(t, routeBinding, publicDirectoryMode)
	assertMode(t, filepath.Join(routeBinding, "versions"), publicDirectoryMode)
	assertMode(t, filepath.Join(routeBinding, "versions", "1.js"), publicFileMode)
	content, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), `example.test`) || strings.Contains(string(content), `next.example.test`) {
		t.Fatalf("rollback did not switch stable config: %s", content)
	}
	inventory, err := runtime.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.RuntimeConfigs) != 1 || inventory.RuntimeConfigs[0].BindingID != routeID || inventory.RuntimeConfigs[0].Generation != 1 {
		t.Fatalf("runtime config inventory = %#v", inventory.RuntimeConfigs)
	}
	if err := runtime.RemoveRuntimeConfig(RuntimeConfigBindingRoute, routeID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("runtime config remains after removal: %v", err)
	}
}

func TestRuntimeConfigRejectsInvalidJSONAndEscapesAssignment(t *testing.T) {
	runtime, _ := newRuntime(t)
	for _, value := range [][]byte{[]byte(`[]`), []byte(`null`), []byte(`"value"`), []byte(`{"unterminated"`), make([]byte, maxRuntimeConfigBytes+1)} {
		if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, value); err == nil {
			t.Fatalf("accepted invalid runtime config %q", value)
		}
	}
	value := []byte(`{"payload":"</script>\\u2028safe"}`)
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingPreview, "preview.pages.example", 1, value); err != nil {
		t.Fatal(err)
	}
	previewBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingPreview, "preview.pages.example")
	assertMode(t, filepath.Join(runtime.root, "runtime-configs"), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.root, "runtime-configs", "previews"), publicDirectoryMode)
	assertMode(t, previewBinding, publicDirectoryMode)
	assertMode(t, filepath.Join(previewBinding, "versions"), publicDirectoryMode)
	assertMode(t, filepath.Join(previewBinding, "versions", "1.js"), publicFileMode)
	path, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingPreview, "preview.pages.example", 1)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "</script>") || !strings.Contains(string(content), `JSON.parse(`) {
		t.Fatalf("runtime assignment was not safely escaped: %s", content)
	}
}

func TestRuntimeConfigRequiresExactStagedGeneration(t *testing.T) {
	runtime, _ := newRuntime(t)
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err == nil {
		t.Fatal("activated an unstaged generation")
	}
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, "not-a-route-id", 1, []byte(`{}`)); err == nil {
		t.Fatal("accepted invalid route binding")
	}
}

func TestRuntimeConfigDiscardsOnlyInactiveStagedGeneration(t *testing.T) {
	runtime, _ := newRuntime(t)
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
		t.Fatal(err)
	}
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2, []byte(`{"route":false}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err != nil {
		t.Fatal(err)
	}
	if err := runtime.DiscardRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "versions", "2.js")); !os.IsNotExist(err) {
		t.Fatalf("staged generation remains after discard: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "versions", "1.js")); err != nil {
		t.Fatalf("active generation was removed: %v", err)
	}
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2, []byte(`{"route":"retry"}`)); err != nil {
		t.Fatal(err)
	}

	if err := runtime.DiscardRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err == nil {
		t.Fatal("discarded the active runtime config generation")
	}
	if _, err := os.Stat(filepath.Join(runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "versions", "1.js")); err != nil {
		t.Fatalf("active generation disappeared after rejected discard: %v", err)
	}
}

func TestRuntimeConfigRejectsSymlinkedGenerationAndCurrentTarget(t *testing.T) {
	t.Run("generation", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
			t.Fatal(err)
		}
		versionPath, err := runtime.runtimeConfigVersionPath(RuntimeConfigBindingRoute, routeID, 1)
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside.js")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		outsideInfo, err := os.Stat(outside)
		if err != nil {
			t.Fatal(err)
		}
		outsideMode := outsideInfo.Mode().Perm()
		if err := os.Remove(versionPath); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, versionPath); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err == nil {
			t.Fatal("accepted symlinked runtime config generation")
		}
		assertMode(t, outside, outsideMode)
	})

	t.Run("current target", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
			t.Fatal(err)
		}
		currentPath, err := runtime.RuntimeConfigPath(RuntimeConfigBindingRoute, routeID)
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside.js")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		outsideInfo, err := os.Stat(outside)
		if err != nil {
			t.Fatal(err)
		}
		outsideMode := outsideInfo.Mode().Perm()
		if err := os.Symlink(outside, currentPath); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err == nil {
			t.Fatal("accepted runtime config current.js target outside binding")
		}
		assertMode(t, outside, outsideMode)
	})
}

func TestStoragePreflightRejectsUnsafeRuntimeConfigPointers(t *testing.T) {
	t.Run("generation symlink", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
			t.Fatal(err)
		}
		versionPath, err := runtime.runtimeConfigVersionPath(RuntimeConfigBindingRoute, routeID, 1)
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside.js")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(versionPath); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, versionPath); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.StoragePreflight(1); err == nil {
			t.Fatal("preflight accepted symlinked runtime config generation")
		}
	})

	t.Run("current target", func(t *testing.T) {
		runtime, _ := newRuntime(t)
		if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
			t.Fatal(err)
		}
		currentPath, err := runtime.RuntimeConfigPath(RuntimeConfigBindingRoute, routeID)
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside.js")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, currentPath); err != nil {
			t.Fatal(err)
		}
		if _, err := runtime.StoragePreflight(1); err == nil {
			t.Fatal("preflight accepted unsafe current.js target")
		}
	})
}

func TestPagesBindingsExposeOnlyDaemonDerivedRuntimeConfigPaths(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)
	if err := runtime.ActivateTagRoute(routeID, deploymentID); err != nil {
		t.Fatal(err)
	}
	routeBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID)
	assertMode(t, routeBinding, publicDirectoryMode)
	assertMode(t, filepath.Join(routeBinding, "versions"), publicDirectoryMode)
	routeFragment, err := os.ReadFile(runtime.routeIncludePath(routeID))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(routeFragment), "$gateway_pages_runtime_config_path "+filepath.Join(runtime.root, "runtime-configs", "routes", routeID, "current.js")) {
		t.Fatalf("route fragment lacks daemon-derived config path: %s", routeFragment)
	}
	const hostname = "preview.pages.example"
	if err := runtime.MaterializePreview(profileID, deploymentID, hostname, "", ""); err != nil {
		t.Fatal(err)
	}
	previewBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingPreview, hostname)
	assertMode(t, previewBinding, publicDirectoryMode)
	assertMode(t, filepath.Join(previewBinding, "versions"), publicDirectoryMode)
	preview, err := os.ReadFile(runtime.previewConfigPath(hostname))
	if err != nil {
		t.Fatal(err)
	}
	configPath, err := runtime.RuntimeConfigPath(RuntimeConfigBindingPreview, hostname)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(preview), "location = /_gateway/pages/config.js") || !strings.Contains(string(preview), "alias "+configPath+";") || !strings.Contains(string(preview), `Cache-Control "no-store, max-age=0"`) {
		t.Fatalf("preview config lacks safe runtime config endpoint: %s", preview)
	}
	if !strings.Contains(string(preview), `sub_filter '</head>' '<script src="/_gateway/pages/config.js"></script></head>';`) {
		t.Fatalf("preview config lacks runtime script injection: %s", preview)
	}
}
