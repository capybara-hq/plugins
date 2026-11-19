import base64
import errno
import json
import os
import re
import stat
import sys
import urllib.parse

MAX_DEPTH = 2
MAX_VISITS = 500
MAX_RESULTS = 50
MAX_NAME = 64
SKIP_ANY = ["node_modules"]
SKIP_BASE = ["Library"]
# ECMAScript whitespace (Python's str.strip also removes several extra control characters).
SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

# Restricted roots ({"denyWrites": true}) follow the shared write policy (sandbox-write-denies.ts).

import unicodedata as _unicodedata
WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in e] for e in [[".gitconfig"],[".gitmodules"],[".bashrc"],[".bash_profile"],[".zshrc"],[".zprofile"],[".profile"],[".ripgreprc"],[".mcp.json"],[".envrc"],[".npmrc"],[".vscode"],[".idea"],[".claude","commands"],[".claude","agents"],[".husky"],[".huskyrc"],[".huskyrc.json"],[".huskyrc.js"],["husky.config.js"],[".pre-commit-config.yaml"],[".pre-commit-config.yml"],["lefthook.yml"],["lefthook.yaml"],["lefthook.json"],["lefthook.toml"],[".lefthook.yml"],[".lefthook.yaml"],[".lefthook.json"],[".lefthook.toml"],["lefthook-local.yml"],["lefthook-local.yaml"],["lefthook-local.json"],["lefthook-local.toml"],[".lefthook-local.yml"],[".lefthook-local.yaml"],[".lefthook-local.json"],[".lefthook-local.toml"],[".lefthook"],[".lefthook-local"],[".config","lefthook.yml"],[".config","lefthook.yaml"],[".config","lefthook.json"],[".config","lefthook.toml"],[".overcommit.yml"],[".simple-git-hooks.json"],[".simple-git-hooks.js"],[".simple-git-hooks.cjs"],["simple-git-hooks.json"],["simple-git-hooks.js"],["simple-git-hooks.cjs"],[".githooks"],[".zshenv"],[".zlogin"],[".zlogout"],[".bash_login"],[".bash_logout"],[".logout"],[".tcshrc"],[".cshrc"],[".kshrc"],[".config","git","config"],[".config","fish","config.fish"],[".config","fish","conf.d"],["library","launchagents"],["library","launchdaemons"],[".config","systemd"],[".local","share","systemd"],[".config","environment.d"],[".config","autostart"],[".config","autostart-scripts"],[".config","plasma-workspace","env"],[".xprofile"],[".xsessionrc"]]]
SYSTEM_WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in p.split("/") if n] for p in ["/var/spool/cron","/var/spool/at","/private/var/at/tabs","/private/var/at/jobs","/var/at"]]
PREFIX_GUARDED = [(e, False) for e in WRITE_DENIES if len(e) > 1] + [(e, True) for e in SYSTEM_WRITE_DENIES]
GIT_ALLOWED_DIRECTORIES = set(["objects","refs","logs","rebase-merge","rebase-apply","sequencer"])
GIT_ALLOWED_FILES = set(["index","head","orig_head","fetch_head","merge_head","merge_msg","merge_mode","merge_rr","auto_merge","cherry_pick_head","revert_head","rebase_head","bisect_log","bisect_start","bisect_expected_rev","bisect_ancestors_ok","bisect_names","bisect_terms","packed-refs","packed-refs.new","merge_autostash","commit_editmsg","tag_editmsg","squash_msg","shallow","description","gc.pid","gc.log","info","modules","worktrees"])
GIT_DANGER = set(["config","config.worktree","commondir","gitdir","hooks","info"])
PROTECTED_PATH_NAMES = set([".git",".gitconfig",".gitmodules",".bashrc",".bash_profile",".zshrc",".zprofile",".profile",".ripgreprc",".mcp.json",".envrc",".npmrc",".vscode",".idea",".husky",".huskyrc",".huskyrc.json",".huskyrc.js","husky.config.js",".pre-commit-config.yaml",".pre-commit-config.yml","lefthook.yml","lefthook.yaml","lefthook.json","lefthook.toml",".lefthook.yml",".lefthook.yaml",".lefthook.json",".lefthook.toml","lefthook-local.yml","lefthook-local.yaml","lefthook-local.json","lefthook-local.toml",".lefthook-local.yml",".lefthook-local.yaml",".lefthook-local.json",".lefthook-local.toml",".lefthook",".lefthook-local",".overcommit.yml",".simple-git-hooks.json",".simple-git-hooks.js",".simple-git-hooks.cjs","simple-git-hooks.json","simple-git-hooks.js","simple-git-hooks.cjs",".githooks",".zshenv",".zlogin",".zlogout",".bash_login",".bash_logout",".logout",".tcshrc",".cshrc",".kshrc",".xprofile",".xsessionrc"])
RESERVED_NAME_PREFIX = ".capybara-staging-"


def _fold_parts(path):
    return [_unicodedata.normalize("NFKC", p).casefold() for p in path.split("/") if p]


def _holds_head(head, prefix):
    if head == "logs":
        return not prefix or (len(prefix) == 3 and prefix[0] == "refs" and prefix[1] == "remotes")
    if head == "refs":
        return len(prefix) == 2 and prefix[0] == "remotes"
    return head == "sequencer" and not prefix


def _subtree_allowed(head, rest):
    for k, name in enumerate(rest):
        if name == ".git":
            return False
        if name == "head" and not (k == len(rest) - 1 and _holds_head(head, rest[:k])):
            return False
        if name in ("objects", "commondir", "gitdir") and _holds_head(head, rest[:k]):
            return False
    return True


def _git_internal_allowed(rel):
    if not rel:
        return True
    head = rel[0]
    if head in GIT_ALLOWED_DIRECTORIES:
        return _subtree_allowed(head, rel[1:])
    if head in ("modules", "worktrees") and len(rel) > 1:
        rest = rel[1:]
        if head == "worktrees":
            return _git_internal_allowed(rest[1:])
        readings = [rest[k + 1:] for k in range(len(rest))]
        if any(r and r[0] in GIT_DANGER and not _git_internal_allowed(r) for r in readings):
            return False
        return any(r and _git_internal_allowed(r) for r in readings)
    if len(rel) == 1:
        base = head[:-5] if head.endswith(".lock") else head
        stash = base.startswith("index.stash.") and base[12:].isascii() and base[12:].isdigit()
        return base in GIT_ALLOWED_FILES or stash
    return head == "info" and len(rel) == 2 and rel[1] in ("exclude", "exclude.lock")


def write_denied(path):
    names = _fold_parts(path)
    if any(n.startswith(RESERVED_NAME_PREFIX) for n in names):
        return True
    for system in SYSTEM_WRITE_DENIES:
        if names[:len(system)] == system:
            return True
    for entry in WRITE_DENIES:
        for i in range(len(names) - len(entry) + 1):
            if names[i:i + len(entry)] == entry:
                return True
    if ".git" in names:
        return not _git_internal_allowed(names[names.index(".git") + 1:])
    return bool(names) and names[-1] == "head"


def _prefix_next(dst):
    nxt = []
    for names, anchored in PREFIX_GUARDED:
        for k in range(1, len(names)):
            if (anchored and len(dst) != k) or len(dst) < k:
                continue
            if dst[len(dst) - k:] == names[:k]:
                nxt.append(names[k])
    return nxt


def move_denied(source, destination, is_dir, entries=None):
    if write_denied(source) or write_denied(destination):
        return True
    src, dst = _fold_parts(source), _fold_parts(destination)
    # an anchored deny's ancestor never moves away: a link resolved into it would dangle
    for names, anchored in PREFIX_GUARDED:
        if anchored and len(src) < len(names) and names[:len(src)] == src:
            return True
    nxt = _prefix_next(dst)
    if nxt:
        if not is_dir:
            return True
        if entries is None:
            # no entries given: list the source path itself, refusing what cannot be listed
            try:
                import os as _os
                entries = _os.listdir(source)
            except OSError:
                return True
        if any(_unicodedata.normalize("NFKC", n).casefold() in nxt for n in entries):
            return True

    def protected_at(names):
        return next((k for k, n in enumerate(names) if n in PROTECTED_PATH_NAMES), -1)

    def same_prefix(n):
        return n >= 0 and len(dst) > n + 1 and dst[:n + 1] == src[:n + 1]
    i = protected_at(src)
    if i >= 0 and not same_prefix(i):
        return True
    j = protected_at(dst)
    if is_dir and j >= 0 and not (i == j and same_prefix(j)):
        return True
    return (not is_dir) and bool(dst) and dst[-1] == ".git"


class ScopeDenied(Exception):
    pass

def units(value):
    return value.encode("utf-16-be", "surrogatepass")

def valid_path(path):
    if not isinstance(path, str) or not path.startswith("/") or len(units(path)) > 8192:
        return False
    if "\\" in path or "//" in path or re.search(r"[\x00-\x1f\x7f]", path):
        return False
    for part in path.split("/"):
        try:
            # decodeURIComponent rejects the entire segment on malformed escapes or UTF-8.
            if re.search(r"%(?![0-9a-fA-F]{2})", part):
                raise ValueError("Malformed percent escape")
            decoded = urllib.parse.unquote(part, errors="strict")
        except (UnicodeError, ValueError):
            decoded = part
        if decoded == ".." or "/" in decoded or "\\" in decoded:
            return False
    return True

def within(root, path):
    return root == "/" or path == root or path.startswith(root + "/")

def valid_name(name):
    return (name not in ("", ".", "..") and len(units(name)) <= MAX_NAME * 2
            and not re.search(r"[\x00-\x1f\x7f/]", name)
            and name[0] not in SPACE and name[-1] not in SPACE)

class NativeFiles:
    def __init__(self, roots):
        self.roots = roots
        self.deny_writes = roots.get("denyWrites") is True
        # Descriptors are supplied by the trusted consumer, never reopened by root pathname.
        for root in roots["read"] + roots["write"]:
            if not valid_path(root["path"]) or os.path.normpath(root["path"]) != root["path"]:
                raise ValueError("Supply canonical absolute root paths")
            if not stat.S_ISDIR(os.fstat(root["fd"]).st_mode):
                raise ValueError("Supply pinned directory descriptors")

    def parent(self, path, write=False, create=False):
        fd, name, _, _ = self.resolve(path, write, create, 0, False)
        return fd, name

    def resolve(self, path, write, create, links, must_exist):
        if not valid_path(path):
            raise ValueError("Supply a valid absolute native path")
        path = os.path.normpath(path)
        if write and self.deny_writes and write_denied(path):
            raise ScopeDenied("Native path is a protected write target")
        roots = self.roots["write"] if write else self.roots["read"] + self.roots["write"]
        matches = [root for root in roots if within(root["path"], path)]
        if not matches:
            raise ScopeDenied("Native path is outside the supplied roots")
        root = max(matches, key=lambda entry: len(entry["path"]))
        fd = os.dup(root["fd"])
        current = root["path"]
        parts = os.path.relpath(path, current).split("/")
        result = self.walk(fd, current, parts, write, create, links, must_exist)
        if write and self.deny_writes and write_denied(result[2]):
            os.close(result[0])
            raise ScopeDenied("Native path is a protected write target")
        return result

    def walk(self, fd, current, parts, write, create, links, must_exist):
        try:
            for index, name in enumerate(parts):
                final = index == len(parts) - 1
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    if not final and create:
                        if self.deny_writes and write_denied(os.path.join(current, name)):
                            raise ScopeDenied("Native path is a protected write target")
                        try:
                            os.mkdir(name, 0o755, dir_fd=fd)
                        except FileExistsError:
                            pass
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    elif final and not must_exist:
                        return fd, name, os.path.normpath(os.path.join(current, name)), links
                    else:
                        raise
                if stat.S_ISLNK(info.st_mode):
                    if links >= 40:
                        raise OSError(errno.ELOOP, "Too many symbolic links")
                    target = os.readlink(name, dir_fd=fd)
                    after = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if (info.st_dev, info.st_ino) != (after.st_dev, after.st_ino):
                        raise ScopeDenied("Native path changed during resolution")
                    target = os.path.normpath(os.path.join(current, target))
                    os.close(fd)
                    fd = None
                    # Resolve the target once. Writes require an existing target; the returned
                    # descriptor/name is reused, including when a directory has a suffix to walk.
                    fd, linked_name, resolved, links = self.resolve(
                        target, write, False, links + 1, must_exist or write)
                    if final:
                        return fd, linked_name, resolved, links
                    try:
                        child = os.open(linked_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                        dir_fd=fd)
                    except NotADirectoryError:
                        if not write:
                            raise FileNotFoundError(errno.ENOENT, "Native target does not exist")
                        raise
                    os.close(fd)
                    fd = None
                    return self.walk(child, resolved, parts[index + 1:], write, create,
                                     links, must_exist)
                if final:
                    return fd, name, os.path.normpath(os.path.join(current, name)), links
                if not write and not stat.S_ISDIR(info.st_mode):
                    # Existing readers treat ENOTDIR in an ancestor as a missing target.
                    raise FileNotFoundError(errno.ENOENT, "Native target does not exist")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                current = os.path.join(current, name)
        except BaseException:
            if fd is not None:
                os.close(fd)
            raise

    def open(self, path, write=False, directory=False):
        parent, name = self.parent(path, write, write)
        try:
            if write and self.deny_writes and _fold_parts(name) == [".git"]:
                os.close(parent)
                parent = None
                raise ScopeDenied("A file named .git would point git elsewhere")
            flags = os.O_NOFOLLOW | os.O_NONBLOCK
            flags |= os.O_WRONLY | os.O_CREAT if write else os.O_RDONLY
            if directory:
                flags |= os.O_DIRECTORY
            return os.open(name, flags, 0o600, dir_fd=parent)
        finally:
            if parent is not None:
                os.close(parent)

    def metadata(self, path):
        parent, name = self.parent(path)
        try:
            value = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(value.st_mode):
                raise ScopeDenied("Native path changed during resolution")
            return value
        finally:
            os.close(parent)

    def entries(self, fd):
        # Dirent type data works even when child metadata cannot be searched. If the
        # filesystem needs a metadata fallback, propagate its errors instead of dropping names.
        with os.scandir(fd) as entries:
            result = [(entry.name, entry.is_dir(follow_symlinks=False), entry.is_symlink())
                      for entry in entries]
        return sorted(result, key=lambda entry: units(entry[0]))

    def listing(self, path, limit):
        fd = self.open(path, directory=True)
        try:
            entries = self.entries(fd)
            result = []
            for name, is_dir, is_link in entries[:limit]:
                if is_link:
                    try:
                        is_dir = stat.S_ISDIR(self.metadata(os.path.join(path, name)).st_mode)
                    except (OSError, ScopeDenied, ValueError):
                        is_dir = False
                result.append({"name": name, "isDir": is_dir})
            return {"entries": result, "truncated": len(entries) > limit}
        finally:
            os.close(fd)

    def scan(self, base):
        # Exactly the SDK traversal: sorted breadth-first levels, count all attempted reads,
        # descend past hits/invalid candidate names, then sort/filter/truncate the final answer.
        base = os.path.normpath(base)
        level = [base]
        found = []
        visits = 0
        depth = 0
        while level and visits < MAX_VISITS:
            next_level = []
            for path in sorted(level, key=units):
                if visits >= MAX_VISITS:
                    break
                visits += 1
                try:
                    fd = self.open(path, directory=True)
                    try:
                        entries = self.entries(fd)
                    finally:
                        os.close(fd)
                except FileNotFoundError:
                    if depth == 0:
                        return []
                    continue
                except (OSError, ScopeDenied, ValueError):
                    if depth == 0:
                        raise
                    continue
                if any(name == ".git" or (name == "AGENTS.md" and not is_dir)
                       for name, is_dir, _ in entries):
                    found.append(path)
                if depth < MAX_DEPTH:
                    for name, is_dir, is_link in entries:
                        if (is_dir and not is_link and not name.startswith(".")
                                and name not in SKIP_ANY and not (depth == 0 and name in SKIP_BASE)):
                            next_level.append(os.path.join(path, name))
            level = next_level
            depth += 1
        return [{"path": path, "suggestedName": os.path.basename(path)}
                for path in sorted(set(found), key=units)
                if valid_name(os.path.basename(path)) and valid_path(path)][:MAX_RESULTS]

    def run(self, request):
        method = request["method"]
        path = request["path"]
        if not valid_path(path):
            raise ValueError("Supply a valid absolute native path")
        if method in ("readFile", "list"):
            bound = request["maxBytes" if method == "readFile" else "limit"]
            if type(bound) is not int or bound < 0 or bound > 9007199254740991:
                raise ValueError("Supply a nonnegative integer byte or entry limit")
        if method == "scan":
            return self.scan(path)
        try:
            if method == "stat":
                info = self.metadata(path)
                return {"size": info.st_size, "isDir": stat.S_ISDIR(info.st_mode)}
            if method == "list":
                return self.listing(path, bound)
            if method == "readFile":
                fd = self.open(path)
                try:
                    info = os.fstat(fd)
                    if stat.S_ISDIR(info.st_mode):
                        return None
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("Native reads require a regular file")
                    want = min(info.st_size, bound)
                    data = bytearray()
                    while len(data) < want:
                        chunk = os.read(fd, want - len(data))
                        if not chunk:
                            break
                        data.extend(chunk)
                finally:
                    os.close(fd)
                return {"dataB64": base64.b64encode(data).decode("ascii"),
                        "truncated": info.st_size > bound}
            if method == "writeFile":
                data = base64.b64decode(request["dataB64"], validate=True)
                fd = self.open(path, write=True)
                try:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        raise ValueError("Native writes require a regular file")
                    os.ftruncate(fd, 0)
                    remaining = memoryview(data)
                    while remaining:
                        written = os.write(fd, remaining)
                        if written == 0:
                            raise OSError(errno.EIO, "Native write made no progress")
                        remaining = remaining[written:]
                finally:
                    os.close(fd)
                return None
            raise ValueError("Unknown native method")
        except FileNotFoundError:
            if method != "writeFile":
                return None
            raise
        except IsADirectoryError:
            if method == "readFile":
                return None
            raise

def main():
    try:
        request = json.load(sys.stdin)
        result = NativeFiles(request["roots"]).run(request)
        response = {"result": result}
    except Exception as error:
        code = ("SCOPE_DENIED" if isinstance(error, ScopeDenied)
                else errno.errorcode.get(getattr(error, "errno", None), "INVALID_NATIVE_REQUEST"))
        # Do not expose symlink targets or other resolved paths in transport errors.
        response = {"error": {"code": code, "message": "Native operation failed; check the path, scope and filesystem access"}}
    print(json.dumps(response), flush=True)

if __name__ == "__main__":
    main()
