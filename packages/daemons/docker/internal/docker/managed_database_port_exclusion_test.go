package docker

import (
	"encoding/json"
	"testing"
)

func TestExcludedHostPortFindsAReservedPick(t *testing.T) {
	cases := []struct {
		name      string
		hostPorts []string
		excluded  []uint16
		want      uint16
		found     bool
	}{
		{name: "picked port reserved", hostPorts: []string{"32768"}, excluded: []uint16{8080, 32768}, want: 32768, found: true},
		{name: "native port reserved", hostPorts: []string{"32770", "32771"}, excluded: []uint16{32771}, want: 32771, found: true},
		{name: "free pick", hostPorts: []string{"32769"}, excluded: []uint16{32768}, found: false},
		{name: "unparsable binding ignored", hostPorts: []string{"", "x"}, excluded: []uint16{0}, found: false},
		{name: "nothing excluded", hostPorts: []string{"32768"}, excluded: nil, found: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, found := excludedHostPort(tc.hostPorts, tc.excluded)
			if found != tc.found || got != tc.want {
				t.Fatalf("excludedHostPort(%v, %v) = %d, %v; want %d, %v", tc.hostPorts, tc.excluded, got, found, tc.want, tc.found)
			}
		})
	}
}

func TestManagedDatabaseCommandAcceptsExcludedHostPorts(t *testing.T) {
	var input managedDatabaseCommand
	if err := jsonUnmarshalForTest(`{"type":"postgres","publishTcp":true,"excludedHostPorts":[8080,9000]}`, &input); err != nil {
		t.Fatal(err)
	}
	if len(input.ExcludedHostPorts) != 2 || input.ExcludedHostPorts[1] != 9000 {
		t.Fatalf("excludedHostPorts = %v", input.ExcludedHostPorts)
	}
	if input.pickedPortAttempts != 0 {
		t.Fatalf("pickedPortAttempts must never come from the controller")
	}
}

func jsonUnmarshalForTest(raw string, target any) error {
	return json.Unmarshal([]byte(raw), target)
}
