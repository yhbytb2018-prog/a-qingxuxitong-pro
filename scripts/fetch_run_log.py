#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读取 GitHub Actions 运行日志（凭据取自 Windows 凭据管理器，token 绝不打印）。
用法: python scripts/fetch_run_log.py <run_id>
"""
import ctypes
import io
import json
import sys
import urllib.request
import zipfile
from ctypes import wintypes


class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def read_token(target="git:https://github.com"):
    """从凭据管理器读 token（CRED_TYPE_GENERIC=1）。"""
    advapi = ctypes.windll.advapi32
    pcred = ctypes.POINTER(CREDENTIAL)()
    ok = advapi.CredReadW(target, 1, 0, ctypes.byref(pcred))
    if not ok:
        raise SystemExit("CredReadW 失败，凭据 target=%r 不存在" % target)
    cred = pcred.contents
    blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
    try:
        token = blob.decode("utf-16-le").strip("\x00").strip()
    except Exception:
        token = blob.decode("utf-8", "ignore").strip()
    user = cred.UserName
    ctypes.windll.kernel32.LocalFree(pcred)
    return user, token


def api_get(url, token, raw=False):
    req = urllib.request.Request(url)
    req.add_header("Authorization", "token " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "sentiment-diag")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if raw else json.loads(data)


def main():
    run_id = sys.argv[1] if len(sys.argv) > 1 else "36583544343"
    user, token = read_token()
    print("凭据用户:", user, "| token 长度:", len(token), "（不打印内容）")

    repo = "sjc19950404/a-sentiment-pro"
    base = "https://api.github.com/repos/%s/actions/runs/%s" % (repo, run_id)
    try:
        blob = api_get(base + "/logs", token, raw=True)
    except urllib.error.HTTPError as e:
        print("日志下载 HTTP", e.code, e.reason)
        return
    zf = zipfile.ZipFile(io.BytesIO(blob))
    print("日志文件:", zf.namelist())

    keys = ["breadth", "[live]", "fallback", "回退", "Error", "error", "失败",
            "skip", "写入", "refresh", "merge-breadth", "连续失败"]
    for name in zf.namelist():
        text = zf.read(name).decode("utf-8", "ignore")
        lines = text.splitlines()
        print("\n===== %s（共 %d 行，摘录关键行）=====" % (name, len(lines)))
        for i, ln in enumerate(lines):
            if any(k in ln for k in keys):
                print("  %s" % ln[:300])


if __name__ == "__main__":
    main()
