//go:build !windows

package main

import "syscall"

func hiddenWindow() *syscall.SysProcAttr {
	return nil
}
