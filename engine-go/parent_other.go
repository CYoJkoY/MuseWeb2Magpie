//go:build !windows

package main

import (
	"errors"
	"syscall"
)

func processAlive(pid int) bool {
	if pid <= 0 {
		return true
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.ESRCH {
		return false
	}
	return true
}
