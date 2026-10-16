#!/usr/bin/env python3
"""Conservatively refine Xiaohongshu Chinese transcripts with qwen-max.

Pipeline: anomaly detection -> candidate correction map -> conservative edit ->
deterministic and independent model review.  The run is resumable and stores
enough information to audit or restore every applied change.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import difflib
import hashlib
import json
import os
import random
import re
import shutil
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any

from dashscope import Generation


SCRIPT_MARKER = "\n## Script\n"
FATAL_ACCOUNT_ERROR = threading.Event()
CHINESE_RE = re.compile(r"[\u3400-\u9fff]")
NUMBER_RE = re.compile(r"(?<![A-Za-z])(?:\d+(?:\.\d+)?%?|[零〇一二两三四五六七八九十百千万亿]+)(?![A-Za-z])")
FORBIDDEN_OUTPUT_RE = re.compile(r"(?m)^\s*(?:```|#{1,6}\s|(?:异常|修改|说明|审查)(?:结果)?[：:])")
REPEAT_RE = re.compile(r"(.{12,}?)(?:\1){2,}", re.S)

# These are candidates, never blind replacements.  qwen-max must validate them
# in context and the review pass can still reject the edit.
GLOBAL_CANDIDATES = {
    "师虎": "石斛",
    "何师虎": "和石斛 / 喝石斛（按上下文判断）",
    "从荣": "苁蓉",
    "肉从荣": "肉苁蓉",
    "九治": "九制",
    "固湿": "固摄",
    "爱气": "嗳气",
    "皇帝内经": "《黄帝内经》",
    "暧宫": "暖宫",
}

AUTHOR_HINTS = {
    "阿飞泡枸杞": {
        "我是咖啡": "我是阿飞",
        "我沙飞": "我是阿飞",
        "我少飞": "我是阿飞",
        "我下边": "我是阿飞（仅限结尾口播）",
        "有我不断": "有我不孤单",
        "有我不在": "有我不孤单",
        "有我孤单": "有我不孤单",
        "别忘布谷鸟": "有我不孤单（仅限固定结尾）",
        "固定口播": "我是阿飞，关注我，你的养生路上有我不孤单。",
    },
    "欧阳会食养": {
        "我是杨中医": "我是欧阳，中医养生（按语法调整）",
        "我收阳": "我是欧阳",
        "收阳中医": "欧阳，中医",
        "寿阳": "欧阳",
        "收牙": "欧阳",
        "说阳": "欧阳",
        "何为养": "合为养（品牌语境）",
        "和养": "合为养（品牌语境）",
        "固定口播": "我是欧阳。养生并不孤单，有我一直陪着你。",
    },
    "袁姐姐全息健康笔记": {
        "形气软化": "行气软化",
        "全西气脉": "全息气脉",
        "全息气麦": "全息气脉",
        "固定专名": "袁姐姐、全息气脉",
    },
}

SAFE_GLOBAL_PAIRS = {
    ("师虎", "石斛"), ("从荣", "苁蓉"), ("肉从荣", "肉苁蓉"),
    ("九治", "九制"), ("固湿", "固摄"), ("爱气", "嗳气"),
    ("皇帝内经", "黄帝内经"), ("皇帝内经", "《黄帝内经》"),
    ("暧宫", "暖宫"), ("齐伯", "岐伯"),
}

SAFE_AUTHOR_PAIRS = {
    "袁姐姐全息健康笔记": {
        ("形气软化", "行气软化"), ("全西气脉", "全息气脉"),
        ("全息气麦", "全息气脉"),
    },
    "阿飞泡枸杞": {
        ("我是咖啡", "我是阿飞"), ("我沙飞", "我是阿飞"),
        ("我少飞", "我是阿飞"), ("有我不断", "有我不孤单"),
        ("有我不在", "有我不孤单"), ("有我孤单", "有我不孤单"),
    },
    "欧阳会食养": {
        ("寿阳", "欧阳"), ("说阳", "欧阳"), ("我收阳", "我是欧阳"),
        ("何为养", "合为养"), ("和养", "合为养"),
    },
    "养生小禾": {
        ("养生小何", "养生小禾"), ("小何", "小禾"),
    },
}

EDITOR_SYSTEM = """你是中文语音转写纠错编辑。任务是修复 ASR 误识，不是改写文章。
必须遵守：
1. 只修有上下文证据的错字、同音误识和作者固定口播；保留口语风格、语气词、标点和原有信息顺序，不做语言润色。
2. 不新增观点、疗效、步骤、剂量、数字、药材、穴位、人物、因果或医学判断；不替作者纠正事实。
3. 尤其保护否定词、条件、频率、时间、数量和单位。无法确定就原样保留，并把 decision 设为 review。
4. 候选映射只是线索，必须结合上下文判断，不能机械替换。
5. 每项 correction 的 from 和 to 必须是可直接精确替换的最短原文片段；不要提交标点优化、同义改写或整句重写。
6. corrected_script 始终输出空字符串；系统只会依据 corrections 中的最短精确替换重建正文。
严格输出一个 JSON 对象，字段为 decision(change|unchanged|review)、anomalies、corrections、corrected_script、uncertainties。
anomalies/corrections/uncertainties 都是数组；corrections 每项含 from、to、reason。
无论 decision 为何，corrected_script 都必须为空字符串。"""

REVIEW_SYSTEM = """你是独立的中文 ASR 改稿审查员。比较原稿与改稿，只判断改动是否保守且有证据。
拒绝任何新增/删失观点、医学含义变化、数字剂量变化、否定或条件变化、专名臆测、语气大幅重写。
允许纠正明显同音字、作者固定口播、标点和异常机械重复。
严格输出 JSON：verdict(pass|reject)、issues（数组）、summary（字符串）。"""


def load_api_key(project: Path) -> str:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if key:
        return key
    env_path = project / ".env"
    text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    match = re.search(r"(?m)^DASHSCOPE_API_KEY=(.*)$", text)
    if not match or not match.group(1).strip():
        raise RuntimeError("DASHSCOPE_API_KEY not found in environment or project .env")
    return match.group(1).strip().strip("\"'")


def extract_json(text: str) -> dict[str, Any]:
    value = text.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value)
        value = re.sub(r"\s*```$", "", value)
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        # Some long responses append a second explanation/object despite the
        # JSON-only instruction.  Decode the first complete object safely.
        start = value.find("{")
        if start < 0:
            raise
        try:
            parsed, _ = json.JSONDecoder().raw_decode(value[start:])
        except json.JSONDecodeError:
            # v2 never trusts the echoed full script.  If that trailing field
            # is truncated, salvage only a fully parseable decision and
            # corrections array; never infer or repair a partial correction.
            decision_match = re.search(r'"decision"\s*:\s*"(change|unchanged|review)"', value)
            corrections_match = re.search(r'"corrections"\s*:\s*', value)
            if not decision_match or not corrections_match:
                raise
            corrections, _ = json.JSONDecoder().raw_decode(value[corrections_match.end():])
            if not isinstance(corrections, list):
                raise
            parsed = {
                "decision": decision_match.group(1),
                "anomalies": [],
                "corrections": corrections,
                "corrected_script": "",
                "uncertainties": ["trailing_model_output_was_truncated"],
            }
    if not isinstance(parsed, dict):
        raise ValueError("model response is not a JSON object")
    return parsed


def call_qwen(api_key: str, system: str, user: str, retries: int = 2) -> tuple[dict[str, Any], dict[str, Any]]:
    error: Exception | None = None
    for attempt in range(retries):
        try:
            response = Generation.call(
                model="qwen-max",
                api_key=api_key,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                result_format="message",
                temperature=0.05,
                top_p=0.2,
                seed=20260904,
                max_tokens=4096,
                response_format={"type": "json_object"},
                timeout=90,
            )
            if response.status_code != 200:
                message = str(response.message or "")
                if "overdue-payment" in message or "account is in good standing" in message:
                    FATAL_ACCOUNT_ERROR.set()
                raise RuntimeError(f"DashScope {response.status_code}: {response.message}")
            content = response.output.choices[0].message.content
            usage = dict(response.usage or {})
            return extract_json(content), usage
        except Exception as exc:
            error = exc
            if attempt + 1 < retries:
                time.sleep((2 ** attempt) + random.random())
    raise RuntimeError(str(error))


def parse_doc(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if text.count(SCRIPT_MARKER) != 1:
        raise ValueError("document must contain exactly one ## Script section")
    prefix, script = text.split(SCRIPT_MARKER, 1)
    account_match = re.search(r"(?m)^- Account: (.*)$", prefix)
    title_match = re.search(r"(?m)^# (.*)$", prefix)
    caption = prefix.split("\n## Caption\n", 1)[1].strip() if "\n## Caption\n" in prefix else ""
    return {
        "text": text,
        "prefix": prefix,
        "script": script.strip(),
        "account": account_match.group(1).strip() if account_match else "",
        "title": title_match.group(1).strip() if title_match else "",
        "caption": caption,
    }


def detect_anomalies(account: str, script: str) -> tuple[list[dict[str, str]], dict[str, str]]:
    anomalies: list[dict[str, str]] = []
    candidates: dict[str, str] = {}
    for source, target in GLOBAL_CANDIDATES.items():
        if source in script:
            candidates[source] = target
            anomalies.append({"span": source, "kind": "domain_candidate"})
    for source, target in AUTHOR_HINTS.get(account, {}).items():
        if source == "固定口播":
            continue
        if source in script:
            candidates[source] = target
            anomalies.append({"span": source, "kind": "author_phrase_candidate"})
    repeat = REPEAT_RE.search(script)
    if repeat:
        anomalies.append({"span": repeat.group(0)[:120], "kind": "mechanical_repetition"})
    odd_runs = re.findall(r"[A-Za-z]{1,3}[\u3400-\u9fff]{1,4}[A-Za-z]{1,3}", script)
    for span in odd_runs[:8]:
        anomalies.append({"span": span, "kind": "mixed_script"})
    return anomalies, candidates


def deterministic_audit(original: str, edited: str) -> dict[str, Any]:
    issues: list[str] = []
    if not edited.strip():
        issues.append("empty_script")
    if FORBIDDEN_OUTPUT_RE.search(edited):
        issues.append("model_scaffolding_or_markdown")
    original_numbers = Counter(NUMBER_RE.findall(original))
    edited_numbers = Counter(NUMBER_RE.findall(edited))
    if original_numbers != edited_numbers:
        issues.append(f"numbers_changed:{dict(original_numbers)}->{dict(edited_numbers)}")
    ratio = len(edited) / max(1, len(original))
    if ratio < 0.72 or ratio > 1.18:
        issues.append(f"length_ratio:{ratio:.3f}")
    similarity = difflib.SequenceMatcher(None, original, edited, autojunk=False).ratio()
    if similarity < 0.72:
        issues.append(f"similarity:{similarity:.3f}")
    original_neg = sum(original.count(char) for char in "不无没未勿莫")
    edited_neg = sum(edited.count(char) for char in "不无没未勿莫")
    if abs(original_neg - edited_neg) > 1:
        issues.append(f"negation_count:{original_neg}->{edited_neg}")
    return {
        "pass": not issues,
        "issues": issues,
        "length_ratio": ratio,
        "similarity": similarity,
        "numbers_before": dict(original_numbers),
        "numbers_after": dict(edited_numbers),
    }


def correction_supported(account: str, source: str, target: str, title: str, caption: str) -> bool:
    pair = (source, target)
    return pair in SAFE_GLOBAL_PAIRS or pair in SAFE_AUTHOR_PAIRS.get(account, set())


def reconstruct_from_supported_corrections(
    original: str, account: str, title: str, caption: str, edit: dict[str, Any]
) -> tuple[str, list[dict[str, str]], list[dict[str, str]]]:
    text = original
    accepted: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    corrections = edit.get("corrections", [])
    if not isinstance(corrections, list):
        return original, accepted, [{"from": "", "to": "", "reason": "invalid_corrections"}]
    for item in corrections:
        if not isinstance(item, dict):
            rejected.append({"from": "", "to": "", "reason": "invalid_correction"})
            continue
        source = str(item.get("from", "")).strip()
        target = str(item.get("to", "")).strip()
        normalized = {"from": source, "to": target, "reason": str(item.get("reason", ""))}
        if not source or not target or source == target or source not in text:
            rejected.append(normalized)
            continue
        if not correction_supported(account, source, target, title, caption):
            rejected.append(normalized)
            continue
        text = text.replace(source, target)
        accepted.append(normalized)
    return text, accepted, rejected


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.rows: dict[str, dict[str, Any]] = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                    old = self.rows.get(row["path"])
                    good = {"approved", "unchanged", "review"}
                    # A later transport/billing failure does not invalidate a
                    # previously completed editorial result.
                    if old and old.get("status") in good and row.get("status") not in good:
                        continue
                    self.rows[row["path"]] = row
                except Exception:
                    continue

    def append(self, row: dict[str, Any]) -> None:
        line = json.dumps(row, ensure_ascii=False)
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
            self.rows[row["path"]] = row


def process_one(path: Path, root: Path, api_key: str, store: StateStore, force: bool) -> dict[str, Any]:
    rel = str(path.relative_to(root))
    doc = parse_doc(path)
    digest = hashlib.sha256(doc["script"].encode()).hexdigest()
    previous = store.rows.get(rel)
    if previous and previous.get("source_sha256") == digest and not force:
        if previous.get("status") in {"unchanged", "review"}:
            return previous
        if previous.get("status") == "approved":
            gated, accepted, rejected = reconstruct_from_supported_corrections(
                doc["script"], doc["account"], doc["title"], doc["caption"], previous.get("model_edit", {})
            )
            audit = deterministic_audit(doc["script"], gated)
            status = "approved" if accepted and not rejected and audit["pass"] else "review"
            migrated = dict(previous)
            migrated.update({
                "status": status, "pipeline_version": 2,
                "approved_script": gated if status == "approved" else "",
                "evidence_gate": {"accepted": accepted, "rejected": rejected},
                "deterministic_audit": audit,
            })
            store.append(migrated)
            return migrated
    if FATAL_ACCOUNT_ERROR.is_set():
        return {"path": rel, "status": "deferred", "error": "fatal_account_error"}
    local_anomalies, candidates = detect_anomalies(doc["account"], doc["script"])
    hint = AUTHOR_HINTS.get(doc["account"], {}).get("固定口播", "")
    user = json.dumps(
        {
            "account": doc["account"],
            "title": doc["title"],
            "caption_context": doc["caption"][:1200],
            "local_anomalies": local_anomalies,
            "candidate_corrections": candidates,
            "known_author_phrase": hint,
            "original_script": doc["script"],
        }, ensure_ascii=False,
    )
    started = time.time()
    try:
        edit, edit_usage = call_qwen(api_key, EDITOR_SYSTEM, user)
        decision = str(edit.get("decision", "review")).lower()
        edited, accepted, rejected = reconstruct_from_supported_corrections(
            doc["script"], doc["account"], doc["title"], doc["caption"], edit
        )
        # A no-change decision is authoritative: never accept incidental
        # whitespace/punctuation drift from the echoed corrected_script.
        if decision == "unchanged":
            edited = doc["script"]
            accepted, rejected = [], []
        audit = deterministic_audit(doc["script"], edited)
        review: dict[str, Any] = {"verdict": "not_run", "issues": []}
        review_usage: dict[str, Any] = {}
        if decision == "change" and accepted and not rejected and edited != doc["script"] and audit["pass"]:
            review_user = json.dumps(
                {
                    "account": doc["account"], "title": doc["title"],
                    "author_phrase_hint": hint,
                    "declared_corrections": accepted,
                    "original_script": doc["script"], "edited_script": edited,
                }, ensure_ascii=False,
            )
            review, review_usage = call_qwen(api_key, REVIEW_SYSTEM, review_user)
        approved = decision == "change" and accepted and not rejected and edited != doc["script"] and audit["pass"] and review.get("verdict") == "pass"
        unchanged = decision == "unchanged" and edited == doc["script"]
        status = "approved" if approved else "unchanged" if unchanged else "review"
        row = {
            "path": rel, "account": doc["account"], "title": doc["title"],
            "source_sha256": digest, "status": status, "pipeline_version": 2,
            "local_anomalies": local_anomalies, "candidate_corrections": candidates,
            "model_edit": edit, "evidence_gate": {"accepted": accepted, "rejected": rejected},
            "deterministic_audit": audit, "model_review": review,
            "original_script": doc["script"], "approved_script": edited if approved else "",
            "usage": {"edit": edit_usage, "review": review_usage},
            "elapsed_seconds": round(time.time() - started, 3),
        }
    except Exception as exc:
        row = {
            "path": rel, "account": doc["account"], "title": doc["title"],
            "source_sha256": digest, "status": "failed", "error": str(exc)[-1000:],
            "local_anomalies": local_anomalies, "candidate_corrections": candidates,
            "original_script": doc["script"], "approved_script": "",
            "elapsed_seconds": round(time.time() - started, 3),
        }
    store.append(row)
    return row


def apply_approved(root: Path, run_dir: Path, rows: list[dict[str, Any]]) -> int:
    backup_root = run_dir / "backups"
    changed = 0
    for row in rows:
        if row.get("status") != "approved" or not row.get("approved_script"):
            continue
        path = root / row["path"]
        doc = parse_doc(path)
        digest = hashlib.sha256(doc["script"].encode()).hexdigest()
        if digest != row["source_sha256"]:
            row["apply_error"] = "source_changed_after_review"
            continue
        backup = backup_root / row["path"]
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
        new_text = doc["prefix"] + SCRIPT_MARKER + row["approved_script"].strip() + "\n"
        temporary = path.with_suffix(path.suffix + ".refine-tmp")
        temporary.write_text(new_text, encoding="utf-8")
        temporary.replace(path)
        changed += 1
    return changed


def write_reports(run_dir: Path, rows: list[dict[str, Any]], applied: int) -> dict[str, Any]:
    counts = Counter(row.get("status", "unknown") for row in rows)
    usage = Counter()
    for row in rows:
        for stage in (row.get("usage") or {}).values():
            for key, value in (stage or {}).items():
                if isinstance(value, (int, float)):
                    usage[key] += value
    summary = {
        "documents": len(rows), "status": dict(counts), "applied": applied,
        "usage": dict(usage),
        "failed_paths": [row["path"] for row in rows if row.get("status") == "failed"],
        "manual_review_paths": [row["path"] for row in rows if row.get("status") == "review"],
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (run_dir / "changes.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            if row.get("status") == "approved":
                handle.write(json.dumps({key: row.get(key) for key in (
                    "path", "account", "title", "model_edit", "deterministic_audit", "model_review",
                )}, ensure_ascii=False) + "\n")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--input-dir", default="output/xiaohongshu")
    parser.add_argument("--run-dir", default="work/xhs-qwen-max-refinement-20260904")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--match", default="", help="Only process paths matching this regular expression")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    project = args.project.resolve()
    root = (project / args.input_dir).resolve()
    run_dir = (project / args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    api_key = load_api_key(project)
    paths = sorted(root.glob("*.md"))
    if args.match:
        matcher = re.compile(args.match)
        paths = [path for path in paths if matcher.search(path.name)]
    if args.limit:
        paths = paths[: args.limit]
    store = StateStore(run_dir / "state.jsonl")
    rows: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(process_one, path, root, api_key, store, args.force): path for path in paths}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            row = future.result()
            rows.append(row)
            print(f"[{index}/{len(paths)}] {row.get('status')}: {row.get('path')}", flush=True)
            if FATAL_ACCOUNT_ERROR.is_set():
                for pending in futures:
                    pending.cancel()
                break
    if FATAL_ACCOUNT_ERROR.is_set():
        print("fatal: DashScope account is not in good standing; checkpoint preserved", flush=True)
        raise SystemExit(3)
    rows.sort(key=lambda row: row["path"])
    applied = apply_approved(root, run_dir, rows) if args.apply else 0
    summary = write_reports(run_dir, rows, applied)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    if summary["failed_paths"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
