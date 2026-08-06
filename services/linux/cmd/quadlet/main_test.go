//go:build linux

package main

import (
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLogfWritesToStderrWhenKmsgUnavailable(t *testing.T) {
	restoreLogGlobals(t)
	noKmsg = true
	kmsgFile = nil
	dryRunFlag = false

	stderr := captureStderr(t, func() {
		Logf("kmsg unavailable")
	})

	assert.Equal(t, expectedLogLine("kmsg unavailable")+"\n", stderr)
}

func TestLogfWritesToStderrWhenKmsgSucceeds(t *testing.T) {
	restoreLogGlobals(t)
	noKmsg = false
	dryRunFlag = false

	tmpFile, err := os.CreateTemp(t.TempDir(), "kmsg")
	require.NoError(t, err)
	t.Cleanup(func() {
		tmpFile.Close()
	})
	kmsgFile = tmpFile

	stderr := captureStderr(t, func() {
		Logf("kmsg succeeds")
	})

	line := expectedLogLine("kmsg succeeds")
	assert.Equal(t, line+"\n", stderr)

	_, err = tmpFile.Seek(0, io.SeekStart)
	require.NoError(t, err)
	kmsg, err := io.ReadAll(tmpFile)
	require.NoError(t, err)
	assert.Equal(t, line, string(kmsg))
}

func TestLogfWritesToStderrInDryRun(t *testing.T) {
	restoreLogGlobals(t)
	noKmsg = true
	kmsgFile = nil
	dryRunFlag = true

	stderr := captureStderr(t, func() {
		Logf("dry run")
	})

	assert.Equal(t, expectedLogLine("dry run")+"\n", stderr)
}

func TestLogfWritesToStderrWhenKmsgWriteFails(t *testing.T) {
	restoreLogGlobals(t)
	noKmsg = false
	dryRunFlag = false

	tmpFile, err := os.CreateTemp(t.TempDir(), "kmsg")
	require.NoError(t, err)
	require.NoError(t, tmpFile.Close())
	kmsgFile = tmpFile

	stderr := captureStderr(t, func() {
		Logf("kmsg write failure")
	})

	assert.Equal(t, expectedLogLine("kmsg write failure")+"\n", stderr)
	assert.Nil(t, kmsgFile)
}

func restoreLogGlobals(t *testing.T) {
	t.Helper()

	oldNoKmsg := noKmsg
	oldKmsgFile := kmsgFile
	oldDryRunFlag := dryRunFlag

	t.Cleanup(func() {
		noKmsg = oldNoKmsg
		kmsgFile = oldKmsgFile
		dryRunFlag = oldDryRunFlag
	})
}

func captureStderr(t *testing.T, f func()) string {
	t.Helper()

	oldStderr := os.Stderr
	reader, writer, err := os.Pipe()
	require.NoError(t, err)

	os.Stderr = writer
	defer func() {
		os.Stderr = oldStderr
	}()

	f()
	require.NoError(t, writer.Close())
	os.Stderr = oldStderr

	output, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())

	return string(output)
}

func expectedLogLine(message string) string {
	return fmt.Sprintf("quadlet-generator[%d]: %s", os.Getpid(), message)
}

func TestIsUnambiguousName(t *testing.T) {
	tests := []struct {
		input string
		res   bool
	}{
		// Ambiguous names
		{"fedora", false},
		{"fedora:latest", false},
		{"library/fedora", false},
		{"library/fedora:latest", false},
		{"busybox@sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", false},
		{"busybox:latest@sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", false},
		{"d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05", false},
		{"d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05aa", false},

		// Unambiguous names
		{"quay.io/fedora", true},
		{"docker.io/fedora", true},
		{"docker.io/library/fedora:latest", true},
		{"localhost/fedora", true},
		{"localhost:5000/fedora:latest", true},
		{"example.foo.this.may.be.garbage.but.maybe.not:1234/fedora:latest", true},
		{"docker.io/library/busybox@sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", true},
		{"docker.io/library/busybox:latest@sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", true},
		{"docker.io/fedora@sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", true},
		{"sha256:d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", true},
		{"d366a4665ab44f0648d7a00ae3fae139d55e32f9712c67accd604bb55df9d05a", true},
	}

	for _, test := range tests {
		res := isUnambiguousName(test.input)
		assert.Equal(t, res, test.res, "%q", test.input)
	}
}
