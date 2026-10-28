#!/usr/bin/env bash
# 分支安全护栏（Claude Code PreToolUse / Bash，接在 .claude/settings.json）。
# 拦截：
#   ① 推送到 main：参数里点名 main（含引号包裹、refs/heads/main 全称、HEAD:main 这类 refspec），
#      或裸 push / 只给 remote / refspec 恰为 HEAD 且当前分支就是 main；
#   ② 在**主 checkout**（不是 worktree）里把 HEAD 切到任务分支
#      feat/ fix/ docs/ chore/ test/ refactor/（checkout / switch，含 -b / -c 建分支）。
#      worktree 里随便切。约定见 AGENTS.md「分支与 worktree」：任务一律 pnpm wt:new。
#      个人可关：`git config capybara.allowMainCheckoutTaskBranch true`（只写本机 .git/config、
#      不入库，只放行 ②，① 照常生效）。
# 阻断方式：输出 permissionDecision=deny 并 exit 0。非 git 命令、非 push/checkout/switch 的 git
# 命令一律放行。依赖 jq（读 stdin 的 .tool_input.command 与 .cwd）。
#
# 解析方式（尽力而为，不是完整的 shell 语法解析）：
# - 不对整条命令做子串匹配，而是先按 shell 控制符（&& || ; |）粗略切成片段，再对每个片段
#   按 token 走「git + 全局选项 + 子命令」，只在子命令之后的参数区里找分支名——这样
#   `git commit -m "...git push origin main..."` 的子命令是 commit，不会误伤。
# - 「当前在哪个仓库」按片段逐个推进：起点是 hook 输入里的 .cwd；`cd <目录>` 片段会改变它，
#   `git -C <目录>` 只作用于本片段。所以 `cd .claude/worktrees/x && git switch feat/y`
#   与 `git -C .claude/worktrees/x switch feat/y` 都按 worktree 判、放行。
# - 是不是主 checkout：`git rev-parse --git-dir` 与 `--git-common-dir`（绝对路径）相同即主
#   checkout，worktree 里两者不同。
#
# 已知残留限制：
# 1) 按 && || ; | 做的是纯文本切分，不识别引号；控制符出现在引号内（`echo "a; git push origin
#    main"`）会被误切成独立片段而按 git 命令处理——方向是过度拦截，对护栏而言是安全的。
# 2) 片段必须以 git（或 cd）开头；`env X=1 git …`、`sudo git …`、`bash -c "git …"`、子 shell、
#    别名、变量展开都不识别，会放过。`cd "$dir"` 这类含变量的目录不解析，沿用原目录。
# 3) push 的参数里恰好有一个叫 main 的普通字符串（而不是 refspec）也会被拒——宁可误伤不放过。
# 4) 规则 ② 在 `--` 之后的 token 一律当路径（`git checkout -- feat/x.ts` 放行），但没写 `--`
#    时分不出分支与路径：`git checkout feat/x.ts` 会被当成切分支而拒绝。恢复单个文件请用
#    `git restore <path>`（restore 不是本 hook 认的子命令，一律放行）。
set -uo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -z "$cmd" ] && exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
[ -z "$cwd" ] && cwd="$PWD"

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# 快速放行：命令文本里完全不含 git 这个词（边界为非字母数字）。
printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]])git([^[:alnum:]]|$)' || exit 0

# 把目录参数解析成绝对路径（相对于 $2）；含变量、命令替换的不解析，输出空。
resolve_dir() {
  local d="$1" base="$2"
  d="${d//\"/}"
  d="${d//\'/}"
  # 下面匹配的是字面的 ~ 并自己展开成 $HOME。
  # shellcheck disable=SC2088
  case "$d" in
    *'$'* | *'`'* | '') return 0 ;;
    '~') d="$HOME" ;;
    '~/'*) d="$HOME/${d:2}" ;;
    /*) ;;
    *) d="$base/$d" ;;
  esac
  (cd "$d" 2>/dev/null && pwd -P) || true
}

# 按 shell 控制符粗略切分命令为片段。
split_re='&&|\|\||;|\|'
segments=()
rest="$cmd"
while [[ "$rest" =~ $split_re ]]; do
  op="${BASH_REMATCH[0]}"
  segments+=("${rest%%"$op"*}")
  rest="${rest#*"$op"}"
done
segments+=("$rest")

for seg in "${segments[@]}"; do
  read -ra toks <<< "$seg"
  [[ "${#toks[@]}" -eq 0 ]] && continue

  # cd 片段：推进后续片段的「当前目录」。
  if [[ "${toks[0]}" == "cd" ]]; then
    if [[ "${#toks[@]}" -ge 2 ]]; then
      next="$(resolve_dir "${toks[1]}" "$cwd")"
      [[ -n "$next" ]] && cwd="$next"
    else
      cwd="$HOME"
    fi
    continue
  fi
  [[ "${toks[0]}" == "git" ]] || continue

  # 跳过全局选项，找子命令；-C <目录> 只作用于本片段，-c <k=v> 等带取值的选项跳过取值。
  dir="$cwd"
  i=1
  while [[ "$i" -lt "${#toks[@]}" && "${toks[$i]}" == -* ]]; do
    case "${toks[$i]}" in
      -C)
        next="$(resolve_dir "${toks[$((i + 1))]:-}" "$dir")"
        [[ -n "$next" ]] && dir="$next"
        i=$((i + 2))
        ;;
      -c | --git-dir | --work-tree | --namespace) i=$((i + 2)) ;;
      *) i=$((i + 1)) ;;
    esac
  done
  [[ "$i" -lt "${#toks[@]}" ]] || continue
  subcmd="${toks[$i]}"
  args=("${toks[@]:$((i + 1))}")

  if [[ "$subcmd" == "push" ]]; then
    # 去掉引号，兼容 `git push origin "main"`。
    norm="${args[*]:-}"
    norm="${norm//\"/}"
    norm="${norm//\'/}"

    # ① 参数区直接点名 main（含 +main、feat/x:main、HEAD:main、refs/heads/main）。
    if [[ "$norm" =~ (^|[[:space:]:+])main([[:space:]]|$) ]] \
      || [[ "$norm" =~ refs/heads/main([[:space:]]|$) ]]; then
      deny "禁止直接推送 main。任务分支用 git push -u origin <branch>，合入 main 走 PR。"
    fi

    # ① 裸 push / 只给 remote / refspec 恰为 HEAD：目标取决于当前分支，运行时解析。
    read -ra ptoks <<< "$norm"
    pos=()
    for t in "${ptoks[@]:-}"; do
      [[ -n "$t" && "$t" != -* ]] && pos+=("$t")
    done
    need_cur=0
    if [[ "${#pos[@]}" -le 1 ]]; then
      need_cur=1
    else
      for ((k = 1; k < ${#pos[@]}; k++)); do
        [[ "${pos[$k]}" == "HEAD" ]] && need_cur=1
      done
    fi
    if [[ "$need_cur" -eq 1 ]]; then
      cur="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
      if [[ "$cur" == "main" ]]; then
        deny "当前在 main，禁止 git push。先切到任务分支（在 worktree 里：pnpm wt:new <branch>）。"
      fi
    fi

  elif [[ "$subcmd" == "checkout" || "$subcmd" == "switch" ]]; then
    allow="$(git -C "$dir" config --get --bool capybara.allowMainCheckoutTaskBranch 2>/dev/null || true)"
    [[ "$allow" == "true" ]] && continue
    paths="$(git -C "$dir" rev-parse --path-format=absolute --git-dir --git-common-dir 2>/dev/null)" || continue
    gitdir="$(printf '%s\n' "$paths" | sed -n 1p)"
    commondir="$(printf '%s\n' "$paths" | sed -n 2p)"
    [[ -n "$gitdir" && "$gitdir" == "$commondir" ]] || continue

    # ② 取目标分支名。建分支形式下最后一个 token 是起点、不是目标：
    #    git checkout --no-track -b feat/x origin/main   -> 目标 feat/x
    #    所以见到 -b / -c / -B / -C 就取紧跟的那个 token；没有这些选项时才取最后一个非选项参数。
    #    `--` 之后是路径，停止解析。
    target=""
    take_next=0
    for tok in "${args[@]:-}"; do
      [[ "$tok" == "--" ]] && break
      if [[ "$take_next" -eq 1 ]]; then
        target="$tok"
        take_next=2
        continue
      fi
      case "$tok" in
        -b | -c | -B | -C) [[ "$take_next" -eq 0 ]] && take_next=1 ;;
        # 合写形式（git switch -cfeat/x）
        -b?* | -c?* | -B?* | -C?*)
          if [[ "$take_next" -eq 0 ]]; then
            target="${tok:2}"
            take_next=2
          fi
          ;;
        -*) ;;
        *) [[ "$take_next" -eq 0 ]] && target="$tok" ;;
      esac
    done
    target="${target//\"/}"
    target="${target//\'/}"
    case "$target" in
      feat/* | fix/* | docs/* | chore/* | test/* | refactor/*)
        # 变量后紧跟中文 / 全角标点时一律写 ${target}：bash 会把全角字符当成变量名的一部分，
        # set -u 下直接崩溃、stdout 为空，hook 静默放行。
        deny "主 checkout 的 HEAD 只停 main，不许切到任务分支（${target}）。
任务一律在 worktree 里做：pnpm wt:new ${target}，然后 cd 到 .claude/worktrees/ 下的目录。
确实要在主 checkout 做任务：git config capybara.allowMainCheckoutTaskBranch true（只影响本机）。"
        ;;
    esac
  fi
done

exit 0
