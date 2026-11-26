//go:build windows

package main

import "syscall"

// hiddenWindow keeps a detached engine from flashing a console window on Windows.
func hiddenWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
