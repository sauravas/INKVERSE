"""Memory guard.

Loading an 18 GB model on a 32 GB shared-memory laptop leaves ~4 GB free and
makes the whole machine thrash. We refuse the load instead, with a message that
says what to do about it.
"""
from __future__ import annotations

import ctypes
import shutil
import subprocess


class _MemStatus(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def memory() -> dict:
    """Return {total_gb, free_gb} using the Windows API, with a POSIX fallback."""
    try:
        st = _MemStatus()
        st.dwLength = ctypes.sizeof(_MemStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            g = 1024 ** 3
            return {"total_gb": round(st.ullTotalPhys / g, 2),
                    "free_gb": round(st.ullAvailPhys / g, 2)}
    except (AttributeError, OSError):
        pass
    try:
        import os
        g = 1024 ** 3
        return {"total_gb": round(os.sysconf("SC_PHYS_PAGES")
                                  * os.sysconf("SC_PAGE_SIZE") / g, 2),
                "free_gb": round(os.sysconf("SC_AVPHYS_PAGES")
                                 * os.sysconf("SC_PAGE_SIZE") / g, 2)}
    except (AttributeError, ValueError, OSError):
        return {"total_gb": 0.0, "free_gb": 0.0}


def check(model_bytes: int, min_free_gb: float) -> tuple[bool, str]:
    """Can we afford to load a model of this size right now?"""
    mem = memory()
    if not mem["total_gb"]:
        return True, ""          # unknown platform: do not block the user
    need = model_bytes / 1024 ** 3 * 1.1          # weights + modest overhead
    free = mem["free_gb"]
    if free - need >= min_free_gb:
        return True, ""
    return False, (
        f"Not enough free memory to load this model: it needs about "
        f"{need:.1f} GB, only {free:.1f} GB is free, and INKWISE keeps "
        f"{min_free_gb:.1f} GB in reserve. Close some applications, unload the "
        f"other model, or switch to a smaller one.")


def ollama_installed() -> bool:
    return shutil.which("ollama") is not None


def serve_hint() -> str:
    return ("Ollama does not appear to be running. Start it with `ollama serve` "
            "(or launch the Ollama app) and try again.")
