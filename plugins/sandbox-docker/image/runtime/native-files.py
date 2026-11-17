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
        roots = self.roots["write"] if write else self.roots["read"] + self.roots["write"]
        matches = [root for root in roots if within(root["path"], path)]
        if not matches:
            raise ScopeDenied("Native path is outside the supplied roots")
        root = max(matches, key=lambda entry: len(entry["path"]))
        fd = os.dup(root["fd"])
        current = root["path"]
        parts = os.path.relpath(path, current).split("/")
        return self.walk(fd, current, parts, write, create, links, must_exist)

    def walk(self, fd, current, parts, write, create, links, must_exist):
        try:
            for index, name in enumerate(parts):
                final = index == len(parts) - 1
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    if not final and create:
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
            flags = os.O_NOFOLLOW | os.O_NONBLOCK
            flags |= os.O_WRONLY | os.O_CREAT if write else os.O_RDONLY
            if directory:
                flags |= os.O_DIRECTORY
            return os.open(name, flags, 0o600, dir_fd=parent)
        finally:
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
