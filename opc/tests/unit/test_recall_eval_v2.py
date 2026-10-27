"""Unit tests for opc/scripts/core/recall_eval_v2.py (recall eval v2 and its ratchet).

Failure list (one test per entry, real imports, no copied logic):
  P1  the hash gets normalised
  P2  a missing hash is dropped silently
  P3  a duplicate-hash row loses relevance
  P4  the loader accepts a malformed row
  P5  NDCG is wrong
  P6  the recall@3 denominator is wrong
  P7  the floor reads the decayed score
  P8  none-precision is inverted
  P9  the sweep rule is wrong
  P10 tokens count the full content
  P11 the eval's query drifts from the one the hook builds (git expansion, intent strip)
  P12 the ratchet lets a regression through
  P13 --check writes the baseline
  P14 --write-baseline lowers a number silently
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

opc_root = Path(__file__).resolve().parents[2]
opc_scripts = opc_root / "scripts"
for p in (opc_root, opc_scripts):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from core import recall_eval_v2 as v2  # noqa: E402

HEADER = {"_header": {"version": 2}}


def _write_set(path: Path, rows: list[dict], header: dict | None = HEADER) -> Path:
    lines = ([json.dumps(header)] if header is not None else []) + [json.dumps(r) for r in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _row(query="q one", category="direct", rel=(("0123456789abcdef", 3),)):
    return {
        "query": query,
        "category": category,
        "relevant": [{"content_hash": h, "grade": g} for h, g in rel],
        "note": "n",
    }


# --------------------------------------------------------------------------- P1


def test_p1_row_hash_is_raw_sha256_prefix_without_normalisation():
    assert v2.row_hash("") == "e3b0c44298fc1c14"
    assert v2.row_hash(" x ") != v2.row_hash("x")
    assert v2.row_hash("X") != v2.row_hash("x")
    assert v2.row_hash("a  b") != v2.row_hash("a b")
    assert v2.row_hash("é") == hashlib.sha256("é".encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- P2, P3


def _live(content, rid, scope="GLOBAL", project_id=None):
    return {"id": rid, "content": content, "scope": scope, "project_id": project_id}


def test_p2_missing_hash_is_reported_not_dropped():
    rows = [_live("alpha", "id-a")]
    found, missing = v2.resolve_hashes(rows, [v2.row_hash("alpha"), "ffffffffffffffff"])
    assert found == {v2.row_hash("alpha"): ["id-a"]}
    assert missing == ["ffffffffffffffff"]


def test_p3_duplicate_hash_rows_all_count_as_relevant():
    rows = [_live("same", "id-1"), _live("same", "id-2"), _live("other", "id-3")]
    found, missing = v2.resolve_hashes(rows, [v2.row_hash("same")])
    assert sorted(found[v2.row_hash("same")]) == ["id-1", "id-2"]
    assert missing == []


def test_reachable_global_or_matching_project_only():
    assert v2.reachable(_live("x", "1", "GLOBAL"), "p1")
    assert v2.reachable(_live("x", "1", "PROJECT", "p1"), "p1")
    assert not v2.reachable(_live("x", "1", "PROJECT", None), "p1")
    assert not v2.reachable(_live("x", "1", "PROJECT", "p2"), "p1")


# --------------------------------------------------------------------------- P4


def test_p4_loader_accepts_a_wellformed_set(tmp_path):
    f = _write_set(tmp_path / "s.jsonl", [_row(), _row("q two", "none", ())])
    header, rows = v2.load_eval_set_v2(f)
    assert header["version"] == 2
    assert [r["query"] for r in rows] == ["q one", "q two"]


@pytest.mark.parametrize(
    "bad_rows, header, reason",
    [
        ([_row(rel=(("XYZ", 3),))], HEADER, "hash"),
        ([_row(rel=(("0123456789abcdef", 4),))], HEADER, "grade"),
        ([_row(category="weird")], HEADER, "category"),
        ([_row(category="none")], HEADER, "none"),
        ([_row(category="direct", rel=())], HEADER, "relevant"),
        ([_row(rel=(("0123456789abcdef", 2),))], HEADER, "grade-3"),
        ([_row(), _row()], HEADER, "duplicate"),
        ([_row()], {"_header": {"version": 1}}, "version"),
    ],
)
def test_p4_loader_rejects_malformed_rows(tmp_path, bad_rows, header, reason):
    f = _write_set(tmp_path / "bad.jsonl", bad_rows, header)
    with pytest.raises(ValueError) as exc:
        v2.load_eval_set_v2(f)
    assert reason in str(exc.value)
    assert "bad.jsonl:" in str(exc.value)  # file:line prefix


# --------------------------------------------------------------------------- P5, P6


def test_p5_ndcg_ideal_order_is_one():
    assert v2.ndcg_graded(["a", "b"], {"a": 3, "b": 1}) == pytest.approx(1.0)


def test_p5_ndcg_grade1_first_then_grade3_is_between_zero_and_one():
    score = v2.ndcg_graded(["b", "a"], {"a": 3, "b": 1})
    assert 0.0 < score < 1.0


def test_p5_ndcg_no_hit_is_zero_and_empty_rel_is_none():
    assert v2.ndcg_graded(["x", "y"], {"a": 3}) == 0.0
    assert v2.ndcg_graded(["a"], {}) is None


def test_p5_ndcg_only_counts_top_k():
    assert v2.ndcg_graded(["x", "x2", "x3", "x4", "x5", "a"], {"a": 3}, k=5) == 0.0


def test_p6_recall_at_3_denominator_is_min_of_rel_and_3():
    assert v2.recall_at(["a", "b", "z"], {"a": 3, "b": 2, "c": 1}) == pytest.approx(2 / 3)
    assert v2.recall_at(["a", "z", "y"], {"a": 3}) == 1.0
    assert v2.recall_at(["a", "b", "c"], {"a": 3, "b": 3, "c": 3, "d": 3}) == 1.0


# --------------------------------------------------------------------------- P7


def _hit(rid="aaaaaaaa-1", base=0.03, score=0.01, rerank=None, content="c" * 60):
    row = {"id": rid, "base_score": base, "score": score, "content": content,
           "type": "WORKING_SOLUTION", "created_at": "2026-10-27T10:00:00+00:00"}
    if rerank is not None:
        row["rerank_score"] = rerank
    return row


def test_p7_floor_reads_base_score_not_decayed_score():
    kept = v2.apply_floor([_hit(base=0.03, score=0.01)], "text", 0.02)
    assert len(kept) == 1
    assert len(v2.apply_floor([_hit(base=0.03, score=0.01)], "hybrid", 0.02)) == 1


def test_p7_rerank_arm_floors_on_rerank_score():
    assert v2.apply_floor([_hit(base=0.9, rerank=0.1)], "rerank", 0.5) == []
    assert len(v2.apply_floor([_hit(base=0.0, rerank=0.9)], "rerank", 0.5)) == 1


def test_apply_floor_keeps_only_top3():
    rows = [_hit(rid=f"r{i}") for i in range(5)]
    assert len(v2.apply_floor(rows, "hybrid", 0.0)) == 3


# --------------------------------------------------------------------------- P8


def _rec(category, k3_rows, rel=None, reachable_ids=None, k5_ids=None, lat=100.0, arm="hybrid"):
    rel = rel or {}
    return {
        "query": f"query {category}",
        "intent": f"query {category}",
        "category": category,
        "rel": rel,
        "reachable_ids": list(rel) if reachable_ids is None else reachable_ids,
        "arms": {
            arm: {
                "k3": {"ids": [r["id"] for r in k3_rows], "rows": k3_rows,
                       "latency_ms": lat, "error": None},
                "k5": {"ids": k5_ids if k5_ids is not None else [r["id"] for r in k3_rows],
                       "rows": [], "latency_ms": lat, "error": None},
            }
        },
    }


def test_p8_none_precision_counts_clean_none_prompts_as_correct():
    clean = _rec("none", [_hit(base=0.005)])
    dirty = _rec("none", [_hit(base=0.02)])
    agg_clean = v2.aggregate_arm([clean], "hybrid", 0.01)
    agg_dirty = v2.aggregate_arm([dirty], "hybrid", 0.01)
    assert agg_clean["none_precision"] == 1.0
    assert agg_dirty["none_precision"] == 0.0
    mixed = v2.aggregate_arm([clean, dirty], "hybrid", 0.01)
    assert mixed["none_precision"] == 0.5


def test_aggregate_hit_rates_and_counts():
    hit = _rec("direct", [_hit(rid="r1", base=0.03)], rel={"r1": 3})
    miss = _rec("direct", [_hit(rid="zz", base=0.03)], rel={"r2": 3})
    orphan = _rec("direct", [_hit(rid="zz", base=0.03)], rel={"r3": 3}, reachable_ids=[])
    partial = _rec("multi", [_hit(rid="r4", base=0.03)], rel={"r4": 3, "r5": 2}, reachable_ids=["r4"])
    none = _rec("none", [])
    agg = v2.aggregate_arm([hit, miss, orphan, partial, none], "hybrid", 0.01)
    assert agg["n_answerable"] == 4
    assert agg["n_reachable"] == 3  # hit, miss, partial
    assert agg["n_partial"] == 1
    assert agg["n_none"] == 1
    assert agg["hit_rate_at_floor"] == pytest.approx(2 / 4)
    assert agg["hit_rate_reachable"] == pytest.approx(2 / 3)
    assert agg["n_errors"] == 0


def test_aggregate_counts_errors_and_mean_tokens_split():
    ok = _rec("direct", [_hit(rid="r1", base=0.03)], rel={"r1": 3})
    quiet = _rec("direct", [], rel={"r2": 3})
    bad = _rec("direct", [], rel={"r3": 3})
    bad["arms"]["hybrid"]["k3"]["error"] = "timeout"
    agg = v2.aggregate_arm([ok, quiet, bad], "hybrid", 0.01)
    assert agg["n_errors"] == 1
    assert agg["n_answerable"] == 2  # the errored query is left out
    assert agg["mean_tokens_injected"] > 0
    assert agg["mean_tokens_all"] == pytest.approx(agg["mean_tokens_injected"] / 2)


# --------------------------------------------------------------------------- P9


def test_p9_choose_floor_prefers_higher_floor_on_tie():
    sweep_rows = [
        {"floor": 0.01, "hit_rate_reachable": 0.8, "false_injection_rate": 0.1, "mean_tokens": 5},
        {"floor": 0.02, "hit_rate_reachable": 0.8, "false_injection_rate": 0.0, "mean_tokens": 4},
        {"floor": 0.03, "hit_rate_reachable": 0.5, "false_injection_rate": 0.0, "mean_tokens": 3},
        {"floor": 0.00, "hit_rate_reachable": 0.9, "false_injection_rate": 0.5, "mean_tokens": 9},
    ]
    chosen = v2.choose_floor(sweep_rows)
    assert chosen["floor"] == 0.02
    assert chosen["constraint_unmet"] is False


def test_p9_choose_floor_infeasible_maximises_hit_minus_fir_and_flags_it():
    sweep_rows = [
        {"floor": 0.01, "hit_rate_reachable": 0.9, "false_injection_rate": 0.9, "mean_tokens": 5},
        {"floor": 0.02, "hit_rate_reachable": 0.5, "false_injection_rate": 0.3, "mean_tokens": 4},
        {"floor": 0.03, "hit_rate_reachable": 0.5, "false_injection_rate": 0.3, "mean_tokens": 3},
    ]
    chosen = v2.choose_floor(sweep_rows)
    assert chosen["floor"] == 0.03  # best hit - FIR (0.2); tie goes to the higher floor
    assert chosen["constraint_unmet"] is True


def test_p9_a_floor_that_injects_nothing_is_never_chosen():
    """Hit 0 and FIR 0 meets the limit by turning recall off (hybrid floor 0.033)."""
    sweep_rows = [
        {"floor": 0.02, "hit_rate_reachable": 0.8, "false_injection_rate": 0.3, "mean_tokens": 5},
        {"floor": 0.03, "hit_rate_reachable": 0.0, "false_injection_rate": 0.0, "mean_tokens": 0},
    ]
    chosen = v2.choose_floor(sweep_rows)
    assert chosen["floor"] == 0.02
    assert chosen["constraint_unmet"] is True


def test_p9_a_feasible_floor_beats_a_zero_hit_floor():
    sweep_rows = [
        {"floor": 0.02, "hit_rate_reachable": 0.5, "false_injection_rate": 0.1, "mean_tokens": 5},
        {"floor": 0.03, "hit_rate_reachable": 0.0, "false_injection_rate": 0.0, "mean_tokens": 0},
    ]
    chosen = v2.choose_floor(sweep_rows)
    assert chosen["floor"] == 0.02
    assert chosen["constraint_unmet"] is False


def test_p9_fir_limit_boundary_is_inclusive():
    rows = [{"floor": 0.01, "hit_rate_reachable": 0.7, "false_injection_rate": 0.2, "mean_tokens": 1}]
    assert v2.choose_floor(rows)["constraint_unmet"] is False


def test_sweep_row_values_and_grids():
    hit = _rec("direct", [_hit(rid="r1", base=0.02)], rel={"r1": 3})
    none = _rec("none", [_hit(base=0.015)])
    rows = v2.sweep([hit, none], "hybrid", [0.01, 0.0175, 0.025])
    by_floor = {r["floor"]: r for r in rows}
    assert by_floor[0.01]["hit_rate_reachable"] == 1.0
    assert by_floor[0.01]["false_injection_rate"] == 1.0
    assert by_floor[0.0175]["hit_rate_reachable"] == 1.0
    assert by_floor[0.0175]["false_injection_rate"] == 0.0
    assert by_floor[0.025]["hit_rate_reachable"] == 0.0
    # grids are built from integers so floors print short and compare exactly
    hybrid = v2.floor_grid("hybrid")
    assert 0.0105 in hybrid and 0.01639 in hybrid and 0.0164 in hybrid and hybrid[0] == 0.01
    assert 0.03275 in hybrid and hybrid[-1] == 0.033
    assert v2.floor_grid("text")[1] == 0.0025 and v2.floor_grid("text")[-1] == 0.1
    assert v2.floor_grid("rerank")[-1] == 1.0 and len(v2.floor_grid("rerank")) == 21


# --------------------------------------------------------------------------- P10


def test_p10_injected_chars_use_the_120_char_preview_not_full_content():
    short = v2.injected_chars("q", [_hit(content="x" * 500)])
    huge = v2.injected_chars("q", [_hit(content="x" * 50000)])
    assert short == huge
    assert short < 400
    assert v2.injected_chars("q", []) == 0


def test_p10_preview_joins_lines_and_marks_truncation_only_when_long():
    one = v2.injected_chars("q", [_hit(content="a\n\n  b  \nc")])
    flat = v2.injected_chars("q", [_hit(content="a b c")])
    assert one == flat
    assert v2.injected_chars("q", [_hit(content="x" * 121)]) == (
        v2.injected_chars("q", [_hit(content="x" * 120)]) + 3
    )


def test_p10_injected_chars_carry_no_stored_date_suffix():
    # The hook never emits "(stored DATE; may be stale)": mergeResults drops storedDate.
    # Re-adding the suffix to injected_chars would make a dated row longer than an undated one.
    dated = _hit()
    undated = {**_hit(), "created_at": None}
    assert v2.injected_chars("q", [dated]) == v2.injected_chars("q", [undated])


def test_tokens_are_ceil_chars_over_4():
    assert v2.tokens_for_chars(0) == 0
    assert v2.tokens_for_chars(1) == 1
    assert v2.tokens_for_chars(4) == 1
    assert v2.tokens_for_chars(5) == 2


# --------------------------------------------------------------------------- P11


REPO_ROOT = opc_root.parent
HAS_NODE_AND_ESBUILD = bool(shutil.which("node")) and (
    REPO_ROOT / ".claude" / "hooks" / "node_modules" / "esbuild"
).exists()


@pytest.mark.skipif(not HAS_NODE_AND_ESBUILD, reason="needs node and .claude/hooks/node_modules")
def test_p11_search_terms_come_from_the_real_hook_functions():
    # Runs the real TypeScript through hook-query-terms.mjs. It fails when expandGitQuery
    # stops appending ' git remote workflow' to a git prompt, when a META_PATTERNS entry
    # such as 'how do i' stops being stripped, or when cleanSearchTerm changes. The expected
    # values were derived by hand from intent-extractor.ts.
    items = v2.hook_search_terms(REPO_ROOT, [
        "what is the git remote policy for this repo",
        "how do I fix the CI in a_b problem",
        "hi",
    ])
    git, how, short = items
    assert git["intent"].endswith(" git remote workflow")
    assert git["term"] == "what the git remote policy for this repo git remote workflow"
    assert how["intent"] == "fix the CI in a_b problem"
    assert how["term"] == "fix the problem"
    assert short["skipped"] and not git["skipped"] and not how["skipped"]


def test_p11_hook_search_terms_rejects_a_node_that_is_missing(monkeypatch):
    monkeypatch.setattr(v2.shutil, "which", lambda name: None)
    with pytest.raises(v2.SetupError, match="node not found"):
        v2.hook_search_terms(REPO_ROOT, ["a prompt that is long enough"])


# --------------------------------------------------------------------------- P12


def _baseline(sha="s1", ndcg=0.60, nonep=0.80, floor=0.015):
    return {
        "eval_set_sha256": sha,
        "default_arm": "hybrid",
        "floors": {"hybrid": floor, "text": 0.01},
        "tolerance": {"ndcg_at_5": 0.03, "none_precision": 0.10},
        "arms": {"hybrid": {"ndcg_at_5": ndcg, "none_precision": nonep}},
    }


def _current(sha="s1", ndcg=0.60, nonep=0.80, n_pairs=48, n_none=10):
    return {
        "eval_set_sha256": sha,
        "n_pairs": n_pairs,
        "n_none": n_none,
        "arms": {"hybrid": {"ndcg_at_5": ndcg, "none_precision": nonep}},
    }


def test_p12_ndcg_drop_of_004_fails_and_002_passes():
    ok, reasons = v2.compare_to_baseline(_current(ndcg=0.56), _baseline())
    assert not ok and any("ndcg" in r for r in reasons)
    ok, reasons = v2.compare_to_baseline(_current(ndcg=0.58), _baseline())
    assert ok and reasons == []


def test_p12_none_precision_drop_beyond_tolerance_fails():
    ok, reasons = v2.compare_to_baseline(_current(nonep=0.60), _baseline())
    assert not ok and any("none_precision" in r for r in reasons)
    ok, _ = v2.compare_to_baseline(_current(nonep=0.70), _baseline())
    assert ok


def test_p12_improvements_pass():
    ok, _ = v2.compare_to_baseline(_current(ndcg=0.9, nonep=1.0), _baseline())
    assert ok


@pytest.mark.parametrize(
    "current",
    [_current(sha="other"), _current(n_pairs=39), _current(n_none=4)],
)
def test_p12_setup_problems_raise_setup_error(current):
    with pytest.raises(v2.SetupError):
        v2.compare_to_baseline(current, _baseline())


# --------------------------------------------------------------------------- P13, P14


GOLD_CONTENT = {"alpha": ("id-a", "GLOBAL", None), "beta": ("id-b", "GLOBAL", None)}


@pytest.fixture
def stub_world(tmp_path, monkeypatch):
    """Patch every outside edge of run_v2 (DB, subprocess, daemon); keep the real logic."""
    live = [_live(c, i, s, p) for c, (i, s, p) in GOLD_CONTENT.items()]

    async def fake_fetch():
        return live

    def fake_arm_query(repo_root, query, arm, k, env, **kw):
        if query.startswith("find"):
            rows = [_hit(rid="id-a", base=0.03, score=0.03)][:k]
        else:
            rows = [_hit(rid="id-b", base=0.001, score=0.001)][:k]
        return {"ids": [r["id"] for r in rows], "rows": rows, "latency_ms": 5.0, "error": None}

    def fake_terms(repo_root, prompts):
        return [{"prompt": p, "intent": p, "term": p, "skipped": None} for p in prompts]

    monkeypatch.setattr(v2, "fetch_live_rows", fake_fetch)
    monkeypatch.setattr(v2, "hook_search_terms", fake_terms)
    monkeypatch.setattr(v2, "run_arm_query", fake_arm_query)
    monkeypatch.setattr(v2, "daemon_ready", lambda: True)
    monkeypatch.setattr(v2, "resolve_hook_project_id", lambda repo_root: "proj-1")
    monkeypatch.setattr(v2, "MIN_PAIRS", 2)
    monkeypatch.setattr(v2, "MIN_NONE", 1)

    gold = [
        _row("find alpha lesson", "direct", ((v2.row_hash("alpha"), 3),)),
        _row("write rust parser", "none", ()),
    ]
    eval_set = _write_set(tmp_path / "set.jsonl", gold)
    return tmp_path, eval_set


def _args(tmp_path, eval_set, **over):
    base = dict(
        eval_set=eval_set, arms="hybrid,text", scope="hook", allow_cold_embed=False,
        check=False, write_baseline=False, allow_lower=False,
        baseline=tmp_path / "baseline.json",
        report_json=tmp_path / "r.json", report_md=tmp_path / "r.md",
        max_pairs=None, timeout=5.0,
    )
    base.update(over)
    return argparse.Namespace(**base)


def test_p2_run_v2_exits_2_when_a_gold_hash_is_missing(stub_world, capsys):
    tmp_path, _ = stub_world
    gold = [_row("find alpha", "direct", ((v2.row_hash("alpha"), 3), ("ffffffffffffffff", 2))),
            _row("none q", "none", ())]
    eval_set = _write_set(tmp_path / "missing.jsonl", gold)
    code = v2.run_v2(_args(tmp_path, eval_set))
    assert code == 2
    assert "1 of 2 gold hashes not found" in capsys.readouterr().err
    assert not (tmp_path / "r.json").exists()


def test_p1_run_v2_sends_the_hook_term_not_the_raw_query(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world
    sent = []

    def spy(repo_root, term, arm, k, env, **kw):
        sent.append(term)
        return {"ids": [], "rows": [], "latency_ms": 1.0, "error": None}

    monkeypatch.setattr(v2, "run_arm_query", spy)
    monkeypatch.setattr(v2, "hook_search_terms", lambda root, prompts: [
        {"prompt": p, "intent": f"I:{p}", "term": f"T:{p}", "skipped": None} for p in prompts])
    assert v2.run_v2(_args(tmp_path, eval_set)) == 0
    assert sent and all(t.startswith("T:") for t in sent)


def test_p1_run_v2_exits_2_when_the_hook_would_skip_a_gold_query(stub_world, monkeypatch, capsys):
    tmp_path, eval_set = stub_world
    monkeypatch.setattr(v2, "hook_search_terms", lambda root, prompts: [
        {"prompt": p, "intent": "", "term": "", "skipped": "prompt shorter than 15 chars"}
        for p in prompts])
    assert v2.run_v2(_args(tmp_path, eval_set)) == 2
    assert "would skip recall" in capsys.readouterr().err


def test_run_v2_exits_2_when_embed_daemon_is_not_ready(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world
    monkeypatch.setattr(v2, "daemon_ready", lambda: False)
    assert v2.run_v2(_args(tmp_path, eval_set)) == 2
    assert v2.run_v2(_args(tmp_path, eval_set, allow_cold_embed=True)) == 0


def test_run_v2_writes_reports_with_default_paths_off(stub_world):
    tmp_path, eval_set = stub_world
    assert v2.run_v2(_args(tmp_path, eval_set)) == 0
    report = json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))
    assert report["_meta"]["project_id"] == "proj-1"
    assert "chosen_floors" in report and set(report["chosen_floors"]) == {"hybrid", "text"}
    assert "## Reachability" in (tmp_path / "r.md").read_text(encoding="utf-8")


def test_p13_check_never_writes_the_baseline(stub_world):
    tmp_path, eval_set = stub_world
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 0
    path = tmp_path / "baseline.json"
    before = path.read_bytes()
    assert v2.run_v2(_args(tmp_path, eval_set, check=True)) == 0
    assert path.read_bytes() == before


def test_p13_check_uses_the_default_baseline_path_when_none_is_given(stub_world, monkeypatch):
    """`--check` with no --baseline has args.baseline None; it must not crash."""
    tmp_path, eval_set = stub_world
    default = tmp_path / "default-baseline.json"
    monkeypatch.setattr(v2, "DEFAULT_BASELINE", default)
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True, baseline=None)) == 0
    assert default.exists()
    assert v2.run_v2(_args(tmp_path, eval_set, check=True, baseline=None)) == 0


def test_errored_queries_do_not_count_as_clean_none_prompts():
    ok_none = _rec("none", [])
    bad_none = _rec("none", [])
    bad_none["arms"]["hybrid"]["k3"]["error"] = "timeout"
    agg = v2.aggregate_arm([ok_none, bad_none], "hybrid", 0.02)
    assert agg["n_none"] == 1
    assert agg["n_errors"] == 1


def test_markdown_prints_counts_as_integers():
    assert v2._fmt(38) == "38"
    assert v2._fmt(0.5) == "0.500"
    assert v2._fmt(True) == "True"


def test_p13_check_without_a_baseline_is_a_setup_error(stub_world):
    tmp_path, eval_set = stub_world
    assert v2.run_v2(_args(tmp_path, eval_set, check=True)) == 2


def test_p13_check_and_write_baseline_are_mutually_exclusive_in_argparse():
    from core import eval_recall

    parser = eval_recall.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args(["--eval-set", "x.jsonl", "--check", "--write-baseline"])
    assert exc.value.code == 2


@pytest.mark.parametrize("flag", ["--check", "--write-baseline", "--allow-lower"])
def test_ratchet_flags_on_a_v1_eval_set_are_an_argparse_error(flag, monkeypatch, capsys):
    """A v1 set would fall through to the v1 path and exit 0 with nothing gated."""
    from core import eval_recall

    v1_set = opc_root / "tests" / "recall_eval_set.jsonl"
    argv = ["eval_recall.py", "--eval-set", str(v1_set), "--report-json", "r.json",
            "--report-md", "r.md", flag]
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(SystemExit) as exc:
        eval_recall.main()
    assert exc.value.code == 2
    assert "version 2" in capsys.readouterr().err


def test_p13_check_exits_1_on_regression(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 0

    def worse(repo_root, query, arm, k, env, **kw):
        rows = [_hit(rid="id-b", base=0.03, score=0.03)][:k]  # wrong id, and a none-prompt hit
        return {"ids": [r["id"] for r in rows], "rows": rows, "latency_ms": 5.0, "error": None}

    monkeypatch.setattr(v2, "run_arm_query", worse)
    assert v2.run_v2(_args(tmp_path, eval_set, check=True)) == 1


def test_p14_write_baseline_refuses_to_lower_without_allow_lower(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world
    path = tmp_path / "baseline.json"
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 0
    before = path.read_bytes()

    def worse(repo_root, query, arm, k, env, **kw):
        rows = [_hit(rid="id-b", base=0.03, score=0.03)][:k]
        return {"ids": [r["id"] for r in rows], "rows": rows, "latency_ms": 5.0, "error": None}

    monkeypatch.setattr(v2, "run_arm_query", worse)
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 1
    assert path.read_bytes() == before
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True, allow_lower=True)) == 0
    assert path.read_bytes() != before


def test_write_baseline_refuses_when_an_arm_has_errors(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world

    def broken(repo_root, query, arm, k, env, **kw):
        return {"ids": [], "rows": [], "latency_ms": 1.0, "error": "timeout"}

    monkeypatch.setattr(v2, "run_arm_query", broken)
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 2
    assert not (tmp_path / "baseline.json").exists()


# --------------------------------------------------------------------------- CodeRabbit #180


def test_cr180_stderr_tail_hides_credentials_when_cut_lands_in_scheme(monkeypatch, tmp_path):
    pw = "hun" + "ter2"
    url = "postgresql://claude:" + pw + "@localhost:5432/db"
    stderr = "boom " + url + " " * (200 - len(url) + 5)  # the 200-char cut starts inside the scheme

    class P:
        returncode = 1
        stdout = ""

    P.stderr = stderr
    monkeypatch.setattr(v2.subprocess, "run", lambda *a, **k: P())
    res = v2.run_arm_query(tmp_path, "q", "hybrid", 3)
    assert res["error"] and pw not in res["error"]


@pytest.mark.parametrize("text", ["[]", '{"arms": 3}', "{}"])
def test_cr180_malformed_baseline_is_a_setup_error(tmp_path, text):
    path = tmp_path / "baseline.json"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(v2.SetupError):
        v2._load_baseline(path)


def test_cr180_project_resolver_failure_exits_2(stub_world, monkeypatch):
    tmp_path, eval_set = stub_world

    def broken(repo_root):
        raise RuntimeError("resolver down")

    monkeypatch.setattr(v2, "resolve_hook_project_id", broken)
    assert v2.run_v2(_args(tmp_path, eval_set)) == 2


def test_cr180_write_baseline_over_a_malformed_baseline_exits_2(stub_world):
    tmp_path, eval_set = stub_world
    (tmp_path / "baseline.json").write_text('{"arms": []}', encoding="utf-8")
    assert v2.run_v2(_args(tmp_path, eval_set, write_baseline=True)) == 2
