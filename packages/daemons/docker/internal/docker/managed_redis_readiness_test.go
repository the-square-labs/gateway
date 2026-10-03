package docker

import (
	"errors"
	"testing"
)

// Redis takes connections while it loads its dataset and answers PING with a
// LOADING error until the data is in memory; only PONG means it serves.
func TestRedisReadinessWaitsForTheLoadedDataset(t *testing.T) {
	failed := errors.New("managed database engine command failed")
	for _, test := range []struct {
		name  string
		reply string
		err   error
		want  error
	}{
		{"loading, redis-cli exits 0", "LOADING Redis is loading the dataset in memory\n", nil, errManagedDatabaseLoading},
		{"loading, redis-cli fails", "(error) LOADING Redis is loading the dataset in memory\n", failed, errManagedDatabaseLoading},
		{"serving", "PONG\n", nil, nil},
		{"not listening yet", "Could not connect to Redis at 127.0.0.1:6379: Connection refused\n", failed, failed},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := managedRedisPingResult(test.reply, test.err); !errors.Is(got, test.want) {
				t.Fatalf("managedRedisPingResult(%q) = %v, want %v", test.reply, got, test.want)
			}
		})
	}
	if err := managedRedisPingResult("NOAUTH Authentication required.\n", nil); err == nil {
		t.Fatal("an error reply with exit code 0 was taken for a serving Redis")
	}
}
