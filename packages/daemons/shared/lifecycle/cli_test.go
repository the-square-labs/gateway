package lifecycle

import "testing"

func TestCommandsWithoutArgumentsRefuseExtraOnes(t *testing.T) {
	for _, args := range [][]string{{"relay-supervisor"}, {"relay-supervisor", "run"}, {"relay-supervisor", "version"}} {
		if err := ExtraArgs(args); err != nil {
			t.Fatalf("%v refused: %v", args, err)
		}
	}
	if err := ExtraArgs([]string{"relay-supervisor", "run", "version"}); err == nil {
		t.Fatal("run version was accepted")
	}
}
