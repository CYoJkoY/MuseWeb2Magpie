//go:build windows

package main

import (
	"errors"
	"syscall"
)

const processQueryLimitedInformation = 0x1000

// processAlive says whether the detached engine should keep running. Only "no such process" is
// proof of death: an access-denied handle means the process is there but locked down.
func processAlive(pid int) bool {
	if pid <= 0 {
		return true
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if handle != 0 {
		_ = syscall.CloseHandle(handle)
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.Errno(87) {
		return false
	}
	return true
}
