package docker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/minio/madmin-go/v3"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const gatewayReadOnlyPolicy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::alpha"]},{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/*"]}]}`

func TestSeaweedFSIAMUpdatePolicyKeepsKeyAndSecret(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	client := newFakeSeaweedFSIAMClient(t, fake)
	principal := "gw-binding-1"
	if _, err := client.createKey(context.Background(), managedStorageIAM{Action: "create_key", Principal: principal, Policy: gatewayBucketPolicy, TargetAccessKey: "GWKEY0001", TargetSecretKey: "secret-0123456789"}); err != nil {
		t.Fatal(err)
	}
	fake.calls = nil
	raw, err := client.updatePolicy(context.Background(), managedStorageIAM{Action: "update_policy", Principal: principal, Policy: gatewayReadOnlyPolicy})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"status":"updated"`) || !strings.Contains(raw, principal) {
		t.Fatalf("update response = %s", raw)
	}
	if want := []string{"GetUser", "PutUserPolicy"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("update calls = %v, want %v", fake.calls, want)
	}
	if got := fake.policies[principal]; !reflect.DeepEqual(got, map[string]string{seaweedfsInlinePolicyName: gatewayReadOnlyPolicy}) {
		t.Fatalf("policies after freeze = %v", got)
	}
	// The key keeps its id and secret: a workload does not need new credentials.
	if fake.secrets["GWKEY0001"] != "secret-0123456789" || !reflect.DeepEqual(fake.keys[principal], []string{"GWKEY0001"}) {
		t.Fatalf("key changed by a policy update: keys=%v secrets=%v", fake.keys, fake.secrets)
	}
	// Restoring the read-write policy is the same call.
	if _, err := client.updatePolicy(context.Background(), managedStorageIAM{Action: "update_policy", Principal: principal, Policy: gatewayBucketPolicy}); err != nil {
		t.Fatal(err)
	}
	if fake.policies[principal][seaweedfsInlinePolicyName] != gatewayBucketPolicy {
		t.Fatalf("policy was not restored: %v", fake.policies[principal])
	}
}

func TestSeaweedFSIAMUpdatePolicyNeverRecreatesAMissingPrincipal(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	client := newFakeSeaweedFSIAMClient(t, fake)
	_, err := client.updatePolicy(context.Background(), managedStorageIAM{Action: "update_policy", Principal: "gw-gone", Policy: gatewayReadOnlyPolicy})
	if err == nil || !isSeaweedFSNoSuchEntity(err) {
		t.Fatalf("update of a missing principal = %v", err)
	}
	if want := []string{"GetUser"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("calls = %v, want %v", fake.calls, want)
	}
	if fake.users["gw-gone"] || len(fake.policies["gw-gone"]) != 0 {
		t.Fatalf("missing principal was recreated: users=%v policies=%v", fake.users, fake.policies)
	}
}

func TestSeaweedFSIAMUpdatePolicyValidatesBeforeCalling(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	client := newFakeSeaweedFSIAMClient(t, fake)
	for name, iam := range map[string]managedStorageIAM{
		"root identity":    {Principal: seaweedfsRootIdentity, Policy: gatewayReadOnlyPolicy},
		"not gateway":      {Principal: "alice", Policy: gatewayReadOnlyPolicy},
		"no policy":        {Principal: "gw-key-1"},
		"admin policy":     {Principal: "gw-key-1", Policy: `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::*"]}]}`},
		"list all buckets": {Principal: "gw-key-1", Policy: `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListAllMyBuckets"],"Resource":["arn:aws:s3:::*"]}]}`},
	} {
		iam.Action = "update_policy"
		if _, err := client.updatePolicy(context.Background(), iam); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatalf("invalid updates reached SeaweedFS: %v", fake.calls)
	}
}

type fakeMinIOServiceAccounts struct {
	accessKey string
	policy    json.RawMessage
	err       error
	calls     int
}

func (f *fakeMinIOServiceAccounts) UpdateServiceAccount(_ context.Context, accessKey string, opts madmin.UpdateServiceAccountReq) error {
	f.calls++
	f.accessKey = accessKey
	f.policy = opts.NewPolicy
	if opts.NewSecretKey != "" || opts.NewStatus != "" || opts.NewExpiration != nil {
		return errors.New("policy update changed more than the policy")
	}
	return f.err
}

func TestMinIOUpdatePolicyReplacesOnlyTheServiceAccountPolicy(t *testing.T) {
	fake := &fakeMinIOServiceAccounts{}
	raw, err := updateMinIOServiceAccountPolicy(context.Background(), fake, &managedStorageIAM{Action: "update_policy", TargetAccessKey: "BINDINGKEY0001", Policy: gatewayReadOnlyPolicy})
	if err != nil || raw != `{"status":"updated"}` {
		t.Fatalf("update = %q, %v", raw, err)
	}
	if fake.accessKey != "BINDINGKEY0001" || string(fake.policy) != gatewayReadOnlyPolicy {
		t.Fatalf("update request = %q %s", fake.accessKey, fake.policy)
	}
	fake.err = errors.New("The specified service account is not found")
	if _, err := updateMinIOServiceAccountPolicy(context.Background(), fake, &managedStorageIAM{Action: "update_policy", TargetAccessKey: "BINDINGKEY0001", Policy: gatewayReadOnlyPolicy}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("MinIO error was not surfaced: %v", err)
	}
}

func TestMinIOUpdatePolicyValidatesBeforeCalling(t *testing.T) {
	fake := &fakeMinIOServiceAccounts{}
	for name, iam := range map[string]*managedStorageIAM{
		"nil":          nil,
		"no key":       {Policy: gatewayReadOnlyPolicy},
		"bad key":      {TargetAccessKey: "a/b", Policy: gatewayReadOnlyPolicy},
		"empty policy": {TargetAccessKey: "BINDINGKEY0001"},
		"not json":     {TargetAccessKey: "BINDINGKEY0001", Policy: `{`},
		"not object":   {TargetAccessKey: "BINDINGKEY0001", Policy: `"s3:*"`},
		"too large":    {TargetAccessKey: "BINDINGKEY0001", Policy: `{"Version":"` + strings.Repeat("x", 64*1024) + `"}`},
	} {
		if _, err := updateMinIOServiceAccountPolicy(context.Background(), fake, iam); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if fake.calls != 0 {
		t.Fatalf("invalid updates reached MinIO: %d", fake.calls)
	}
}

// The real madmin client against a fake admin endpoint: the request is the
// encrypted update-service-account call carrying only the new policy.
func TestMinIOUpdatePolicyUsesTheAdminUpdateServiceAccountCall(t *testing.T) {
	var gotPath, gotAccessKey string
	var gotRequest madmin.UpdateServiceAccountReq
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAccessKey = r.URL.Query().Get("accessKey")
		plain, err := madmin.DecryptData("root-secret-0000", r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := json.Unmarshal(plain, &gotRequest); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	client, err := madmin.NewWithOptions(endpoint.Host, &madmin.Options{Creds: credentials.NewStaticV4("root-access", "root-secret-0000", "")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := updateMinIOServiceAccountPolicy(context.Background(), client, &managedStorageIAM{Action: "update_policy", TargetAccessKey: "OPERATORKEY01", Policy: gatewayReadOnlyPolicy}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(gotPath, "/update-service-account") || gotAccessKey != "OPERATORKEY01" {
		t.Fatalf("admin call = %s accessKey=%s", gotPath, gotAccessKey)
	}
	var policy map[string]any
	if err := json.Unmarshal(gotRequest.NewPolicy, &policy); err != nil || policy["Version"] != "2012-10-17" {
		t.Fatalf("new policy = %s", gotRequest.NewPolicy)
	}
	if gotRequest.NewSecretKey != "" || gotRequest.NewStatus != "" || gotRequest.NewExpiration != nil {
		t.Fatalf("update touched more than the policy: %#v", gotRequest)
	}
}

func TestManagedStorageUpdatePolicyRejectsMismatchedPayload(t *testing.T) {
	manager := &managedStorageManager{root: t.TempDir(), logger: slog.Default()}
	if err := os.MkdirAll(filepath.Join(manager.root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	minio := "11111111-1111-4111-8111-111111111111"
	seaweedfs := "22222222-2222-4222-8222-222222222222"
	if err := manager.saveRecord(managedStorageRecord{ID: minio}); err != nil {
		t.Fatal(err)
	}
	if err := manager.saveRecord(managedStorageRecord{ID: seaweedfs, Engine: managedStorageEngineSeaweedFS}); err != nil {
		t.Fatal(err)
	}
	root := managedStorageRootCreds{AccessKey: "root-access", SecretKey: "root-secret-0000"}
	legacy := managedStorageCommand{Version: 1, RootCredentials: root, IAM: &managedStorageIAM{Action: "remove_key", TargetAccessKey: "BINDINGKEY0001", Policy: gatewayReadOnlyPolicy}}
	if _, err := manager.handle(context.Background(), "iam_update_policy", minio, encodeManagedStorageCommand(t, legacy)); err == nil || !strings.Contains(err.Error(), "action mismatch") {
		t.Fatalf("MinIO update_policy with a remove_key payload = %v", err)
	}
	current := managedStorageCommand{Version: 1, Engine: managedStorageEngineSeaweedFS, RootCredentials: root, IAM: &managedStorageIAM{Action: "create_key", Principal: "gw-key-1", Policy: gatewayReadOnlyPolicy}}
	if _, err := manager.handle(context.Background(), "iam_update_policy", seaweedfs, encodeManagedStorageCommand(t, current)); err == nil || !strings.Contains(err.Error(), "action mismatch") {
		t.Fatalf("SeaweedFS update_policy with a create_key payload = %v", err)
	}
	current.IAM = &managedStorageIAM{Action: "update_policy", Principal: seaweedfsRootIdentity, Policy: gatewayReadOnlyPolicy}
	if _, err := manager.handle(context.Background(), "iam_update_policy", seaweedfs, encodeManagedStorageCommand(t, current)); err == nil || !strings.Contains(err.Error(), "principal is invalid") {
		t.Fatalf("SeaweedFS update_policy of the root identity = %v", err)
	}
}
