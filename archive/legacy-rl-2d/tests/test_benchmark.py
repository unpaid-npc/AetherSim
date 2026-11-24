"""Unit and smoke tests for Stage 1 benchmark module."""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import numpy as np
import pytest

import benchmark
from benchmark import (
    DEFAULT_POLICIES,
    EPISODE_CSV_FIELDS,
    SUMMARY_CSV_FIELDS,
    PolicySpec,
    aggregate_episode_results,
    classify_episode_outcome,
    evaluate_policy,
    extract_touchdown_metrics,
    run_benchmark,
)


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        (
            {
                "terminated": False,
                "truncated": True,
                "game_over": False,
                "lander_awake": True,
                "obs_x": 0.1,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "timeout",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": True,
                "lander_awake": False,
                "obs_x": 0.0,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "crash",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": True,
                "obs_x": 1.0,
                "lander_world_x": 20.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "out_of_bounds",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": True,
                "obs_x": -1.05,
                "lander_world_x": -0.5,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "out_of_bounds",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.0,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "success_between_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": -0.2,
                "lander_world_x": 8.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "success_between_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.2,
                "lander_world_x": 12.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "success_between_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": -0.21,
                "lander_world_x": 7.9,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "safe_outside_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.21,
                "lander_world_x": 12.1,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "safe_outside_flags",
        ),
        # Edge case: both terminated and truncated on step 1000 must not be timeout
        (
            {
                "terminated": True,
                "truncated": True,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.05,
                "lander_world_x": 10.5,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": True,
            },
            "success_between_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": True,
                "game_over": True,
                "lander_awake": True,
                "obs_x": 0.0,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "crash",
        ),
        (
            {
                "terminated": True,
                "truncated": True,
                "game_over": False,
                "lander_awake": True,
                "obs_x": 1.0,
                "lander_world_x": 20.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "out_of_bounds",
        ),
        # Edge case: safe rest inside flags with only one leg touching -> safe_outside_flags
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.0,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": True,
                "right_leg_contact": False,
            },
            "safe_outside_flags",
        ),
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": False,
                "lander_awake": False,
                "obs_x": 0.0,
                "lander_world_x": 10.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": True,
            },
            "safe_outside_flags",
        ),
        # Edge case: game_over takes precedence over out_of_bounds
        (
            {
                "terminated": True,
                "truncated": False,
                "game_over": True,
                "lander_awake": True,
                "obs_x": 1.1,
                "lander_world_x": 21.0,
                "helipad_x1": 8.0,
                "helipad_x2": 12.0,
                "left_leg_contact": False,
                "right_leg_contact": False,
            },
            "crash",
        ),
    ],
)
def test_classify_episode_outcome_categories_and_edge_cases(
    kwargs: dict[str, object], expected: str
) -> None:
    assert classify_episode_outcome(**kwargs) == expected  # type: ignore[arg-type]


def test_classify_episode_outcome_invalid_state_raises() -> None:
    with pytest.raises(ValueError, match="Unexpected terminal episode state"):
        classify_episode_outcome(
            terminated=False,
            truncated=False,
            game_over=False,
            lander_awake=True,
            obs_x=0.0,
            lander_world_x=10.0,
            helipad_x1=8.0,
            helipad_x2=12.0,
            left_leg_contact=False,
            right_leg_contact=False,
        )


def test_extract_touchdown_metrics_and_no_contact_aggregation() -> None:
    obs_air_1 = np.array([0.0, 0.5, -0.3, -0.4, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    obs_air_2 = np.array([0.0, 0.4, -0.3, -0.4, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    obs_td = np.array([0.0, 0.0, -0.05, -0.02, 0.0, 0.0, 1.0, 0.0], dtype=np.float32)
    obs_rest = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0], dtype=np.float32)

    vy, spd, had = extract_touchdown_metrics(obs_air_1, obs_air_2, False)
    assert (vy, spd, had) == (None, None, False)

    vy, spd, had = extract_touchdown_metrics(obs_air_2, obs_td, had)
    assert had is True
    assert vy == pytest.approx(0.4, abs=1e-6)
    assert spd == pytest.approx(math.hypot(-0.3, -0.4), abs=1e-6)

    # Subsequent contacts (including bounce/recontact) must be ignored once had_leg_contact=True
    vy2, spd2, had2 = extract_touchdown_metrics(obs_td, obs_rest, had)
    assert (vy2, spd2, had2) == (None, None, True)

    agg = aggregate_episode_results(
        [
            {
                "policy": "p",
                "seed": 1,
                "reward": -150.0,
                "steps": 60,
                "outcome": "crash",
                "touchdown_vertical_speed": None,
                "touchdown_speed": None,
            }
        ]
    )
    assert agg["n_with_touchdown"] == 0
    assert agg["touchdown_vertical_speed_mean"] is None
    assert agg["touchdown_vertical_speed_std"] is None
    assert agg["touchdown_speed_mean"] is None
    assert agg["touchdown_speed_std"] is None


def test_evaluate_policy_random_baseline_determinism() -> None:
    random_spec = DEFAULT_POLICIES[0]
    summary_a, rows_a = evaluate_policy(random_spec, [42, 43])
    summary_b, rows_b = evaluate_policy(random_spec, [42, 43])

    assert summary_a["status"] == "ok"
    assert summary_a["episodes_evaluated"] == 2
    assert summary_a["metrics"] == summary_b["metrics"]
    assert rows_a == rows_b


def test_evaluate_policy_missing_checkpoint_degradation() -> None:
    missing_spec = PolicySpec(
        name="missing_policy",
        checkpoint_path="models/nonexistent_checkpoint_for_test.zip",
    )
    summary, rows = evaluate_policy(missing_spec, [42, 43])

    assert summary["status"] == "missing"
    assert summary["episodes_evaluated"] == 0
    assert summary["metrics"] is None
    assert summary["error"]
    assert rows == []


def test_ppo_1m_deterministic_inference_smoke() -> None:
    ppo_1m_spec = next(p for p in DEFAULT_POLICIES if p.name == "ppo_1m_shaped")
    assert ppo_1m_spec.checkpoint_path is not None
    if not Path(ppo_1m_spec.checkpoint_path).is_file():
        pytest.skip(f"Checkpoint not present: {ppo_1m_spec.checkpoint_path}")

    summary_a, rows_a = evaluate_policy(ppo_1m_spec, [42, 43], deterministic=True)
    summary_b, rows_b = evaluate_policy(ppo_1m_spec, [42, 43], deterministic=True)

    assert summary_a["status"] == "ok"
    assert summary_a["episodes_evaluated"] == 2
    assert len(rows_a) == 2
    assert rows_a == rows_b
    assert summary_a["metrics"] == summary_b["metrics"]


def test_save_results_roundtrip(tmp_path: Path) -> None:
    summary, episodes, saved = run_benchmark(
        policies=(DEFAULT_POLICIES[0],),
        episodes=2,
        seed_start=42,
        output_dir=tmp_path,
    )
    assert saved is not None
    assert summary["policies"]["random_baseline"]["status"] == "ok"

    json_path = saved["summary_json"]
    sum_csv_path = saved["summary_csv"]
    ep_csv_path = saved["episodes_csv"]
    assert json_path.is_file() and sum_csv_path.is_file() and ep_csv_path.is_file()

    parsed_json = json.loads(json_path.read_text(encoding="utf-8"))
    assert "metadata" in parsed_json and "policies" in parsed_json
    counts = parsed_json["policies"]["random_baseline"]["metrics"]["outcome_counts"]
    assert sum(counts.values()) == 2

    with sum_csv_path.open("r", encoding="utf-8", newline="") as f:
        sum_reader = csv.DictReader(f)
        assert tuple(sum_reader.fieldnames or ()) == SUMMARY_CSV_FIELDS
        sum_rows = list(sum_reader)
    assert len(sum_rows) == 1
    assert sum_rows[0]["policy"] == "random_baseline"

    with ep_csv_path.open("r", encoding="utf-8", newline="") as f:
        ep_reader = csv.DictReader(f)
        assert tuple(ep_reader.fieldnames or ()) == EPISODE_CSV_FIELDS
        ep_rows = list(ep_reader)
    assert len(ep_rows) == len(episodes) == 2
    assert [int(r["seed"]) for r in ep_rows] == [42, 43]
