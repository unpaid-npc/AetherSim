"""Deterministic, reproducible multi-policy benchmark for unshaped LunarLander-v3."""

from __future__ import annotations

import argparse
import csv
import importlib.metadata
import json
import logging
import math
import platform
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import gymnasium as gym
import numpy as np
from stable_baselines3 import PPO

from planets import PLANETARY_PRESETS, PLANET_CHOICES, get_planet_config, make_planet_env

logger = logging.getLogger(__name__)

ENV_ID = "LunarLander-v3"
SOLVED_REWARD_THRESHOLD = 200.0
OUTCOME_CATEGORIES = (
    "success_between_flags",
    "safe_outside_flags",
    "crash",
    "out_of_bounds",
    "timeout",
)

SUMMARY_CSV_FIELDS = (
    "policy",
    "status",
    "error",
    "checkpoint_path",
    "num_timesteps",
    "episodes_evaluated",
    "reward_mean",
    "reward_std",
    "reward_min",
    "reward_median",
    "reward_max",
    "solved_rate_pct",
    "steps_mean",
    "steps_std",
    "success_between_flags_pct",
    "safe_outside_flags_pct",
    "crash_pct",
    "out_of_bounds_pct",
    "timeout_pct",
    "n_with_touchdown",
    "touchdown_vertical_speed_mean",
    "touchdown_vertical_speed_std",
    "touchdown_speed_mean",
    "touchdown_speed_std",
)

EPISODE_CSV_FIELDS = (
    "policy",
    "seed",
    "reward",
    "steps",
    "outcome",
    "touchdown_vertical_speed",
    "touchdown_speed",
    "final_x",
    "final_y",
    "final_angle",
    "left_leg_contact",
    "right_leg_contact",
)

PLANET_META_CSV_FIELDS = (
    "planet",
    "gravity",
    "enable_wind",
    "wind_power",
    "turbulence_power",
    "real_gravity_mps2",
    "atmosphere_label",
)

PLANET_SUMMARY_CSV_FIELDS = PLANET_META_CSV_FIELDS + SUMMARY_CSV_FIELDS
PLANET_EPISODE_CSV_FIELDS = ("planet",) + EPISODE_CSV_FIELDS


@dataclass(frozen=True)
class PolicySpec:
    """Configuration describing a benchmarked policy."""

    name: str
    checkpoint_path: str | None
    is_random: bool = False


DEFAULT_POLICIES: tuple[PolicySpec, ...] = (
    PolicySpec(name="random_baseline", checkpoint_path=None, is_random=True),
    PolicySpec(
        name="ppo_100k_unshaped",
        checkpoint_path="models/PPO/ppo_lunarlander_100k.zip",
    ),
    PolicySpec(
        name="ppo_500k_shaped",
        checkpoint_path="models/PPO_Shaped/ppo_lunarlander_shaped_500k.zip",
    ),
    PolicySpec(
        name="ppo_1m_shaped",
        checkpoint_path="models/PPO_Final/ppo_lunarlander_final_1M.zip",
    ),
)


def classify_episode_outcome(
    *,
    terminated: bool,
    truncated: bool,
    game_over: bool,
    lander_awake: bool,
    obs_x: float,
    lander_world_x: float,
    helipad_x1: float,
    helipad_x2: float,
    left_leg_contact: bool,
    right_leg_contact: bool,
) -> str:
    """Classify a finished LunarLander-v3 episode into a mutually exclusive outcome.

    Matches Gymnasium 1.4.0 ``lunar_lander.py`` and ``TimeLimit.step()`` semantics:
    1. ``timeout``: truncated by ``TimeLimit`` without environment termination.
    2. ``crash``: lander body contacted ground (``env.unwrapped.game_over == True``).
    3. ``out_of_bounds``: horizontal normalized position left viewport (``abs(obs[0]) >= 1.0``).
    4. ``success_between_flags``: Box2D body went to sleep (``terminated and not lander_awake``)
       with both legs in ground contact and ``lander.position.x`` within ``[helipad_x1, helipad_x2]``.
    5. ``safe_outside_flags``: Box2D body went to sleep safely without meeting full between-flags
       two-leg pad criteria.
    """
    if truncated and not terminated:
        return "timeout"
    if game_over:
        return "crash"
    if abs(obs_x) >= 1.0:
        return "out_of_bounds"
    if terminated and not lander_awake:
        between_flags = helipad_x1 <= lander_world_x <= helipad_x2
        if between_flags and left_leg_contact and right_leg_contact:
            return "success_between_flags"
        return "safe_outside_flags"
    if truncated:
        return "timeout"
    raise ValueError(
        "Unexpected terminal episode state: "
        f"terminated={terminated}, truncated={truncated}, game_over={game_over}, "
        f"lander_awake={lander_awake}, obs_x={obs_x}"
    )


def extract_touchdown_metrics(
    prev_obs: Sequence[float] | np.ndarray,
    obs: Sequence[float] | np.ndarray,
    had_leg_contact: bool,
) -> tuple[float | None, float | None, bool]:
    """Capture pre-impact speed on the first transition from airborne to leg contact.

    Uses ``prev_obs`` (the observation immediately before Box2D's collision solver damps
    velocity on the contact step) when transitioning from ``had_leg_contact == False``
    to at least one leg contacting the ground (``obs[6] > 0.5 or obs[7] > 0.5``).
    """
    leg_contact_now = bool(float(obs[6]) > 0.5 or float(obs[7]) > 0.5)
    if not had_leg_contact and leg_contact_now:
        vx = float(prev_obs[2])
        vy = float(prev_obs[3])
        return abs(vy), math.hypot(vx, vy), True
    return None, None, had_leg_contact or leg_contact_now


def _mean_std(values: Sequence[float]) -> tuple[float, float]:
    arr = np.asarray(values, dtype=np.float64)
    return float(np.mean(arr)), float(np.std(arr, ddof=0))


def aggregate_episode_results(episode_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute aggregated return, length, outcome, and touchdown metrics for one policy."""
    n = len(episode_rows)
    if n == 0:
        raise ValueError("Cannot aggregate empty episode_rows.")

    rewards = np.asarray([float(row["reward"]) for row in episode_rows], dtype=np.float64)
    steps = np.asarray([int(row["steps"]) for row in episode_rows], dtype=np.float64)
    solved_count = int(np.sum(rewards >= SOLVED_REWARD_THRESHOLD))

    outcome_counts = {cat: 0 for cat in OUTCOME_CATEGORIES}
    for row in episode_rows:
        outcome = str(row["outcome"])
        if outcome not in outcome_counts:
            raise ValueError(f"Unknown outcome category: {outcome!r}")
        outcome_counts[outcome] += 1

    outcome_rates_pct = {cat: 100.0 * count / n for cat, count in outcome_counts.items()}

    td_vy_vals = [
        float(row["touchdown_vertical_speed"])
        for row in episode_rows
        if row["touchdown_vertical_speed"] is not None
    ]
    td_speed_vals = [
        float(row["touchdown_speed"])
        for row in episode_rows
        if row["touchdown_speed"] is not None
    ]
    n_td = len(td_vy_vals)
    if n_td > 0:
        td_vy_mean, td_vy_std = _mean_std(td_vy_vals)
        td_speed_mean, td_speed_std = _mean_std(td_speed_vals)
    else:
        td_vy_mean = td_vy_std = td_speed_mean = td_speed_std = None

    return {
        "episodes_evaluated": n,
        "reward_mean": float(np.mean(rewards)),
        "reward_std": float(np.std(rewards, ddof=0)),
        "reward_min": float(np.min(rewards)),
        "reward_median": float(np.median(rewards)),
        "reward_max": float(np.max(rewards)),
        "solved_count": solved_count,
        "solved_rate_pct": 100.0 * solved_count / n,
        "steps_mean": float(np.mean(steps)),
        "steps_std": float(np.std(steps, ddof=0)),
        "outcome_counts": outcome_counts,
        "outcome_rates_pct": outcome_rates_pct,
        "n_with_touchdown": n_td,
        "touchdown_rate_pct": 100.0 * n_td / n,
        "touchdown_vertical_speed_mean": td_vy_mean,
        "touchdown_vertical_speed_std": td_vy_std,
        "touchdown_speed_mean": td_speed_mean,
        "touchdown_speed_std": td_speed_std,
    }


def _load_policy_model(
    policy: PolicySpec,
) -> tuple[PPO | None, dict[str, Any]]:
    """Resolve checkpoint metadata and load a PPO policy with graceful degradation."""
    if policy.is_random:
        return None, {
            "policy": policy.name,
            "checkpoint_path": None,
            "status": "ok",
            "error": None,
            "file_size_bytes": None,
            "file_mtime_utc": None,
            "num_timesteps": 0,
        }

    ckpt_str = policy.checkpoint_path
    if not ckpt_str:
        msg = f"No checkpoint path configured for policy {policy.name!r}."
        logger.warning(msg)
        return None, {
            "policy": policy.name,
            "checkpoint_path": ckpt_str,
            "status": "missing",
            "error": msg,
            "file_size_bytes": None,
            "file_mtime_utc": None,
            "num_timesteps": None,
        }

    ckpt_path = Path(ckpt_str)
    if not ckpt_path.is_file():
        msg = f"Checkpoint file not found: {ckpt_str}"
        logger.warning("%s (policy=%s)", msg, policy.name)
        return None, {
            "policy": policy.name,
            "checkpoint_path": ckpt_str,
            "status": "missing",
            "error": msg,
            "file_size_bytes": None,
            "file_mtime_utc": None,
            "num_timesteps": None,
        }

    stat = ckpt_path.stat()
    file_size = int(stat.st_size)
    file_mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

    try:
        model = PPO.load(str(ckpt_path), device="cpu")
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        logger.warning("Failed to load checkpoint %s (%s): %s", ckpt_str, policy.name, msg)
        return None, {
            "policy": policy.name,
            "checkpoint_path": ckpt_str,
            "status": "load_error",
            "error": msg,
            "file_size_bytes": file_size,
            "file_mtime_utc": file_mtime,
            "num_timesteps": None,
        }

    return model, {
        "policy": policy.name,
        "checkpoint_path": ckpt_str,
        "status": "ok",
        "error": None,
        "file_size_bytes": file_size,
        "file_mtime_utc": file_mtime,
        "num_timesteps": int(model.num_timesteps),
    }


def evaluate_policy(
    policy: PolicySpec,
    seeds: Sequence[int],
    *,
    env_id: str = ENV_ID,
    deterministic: bool = True,
    planet: str = "default",
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Evaluate a single policy on an unshaped environment across fixed episode seeds."""
    planet_cfg = get_planet_config(planet)
    model, base_entry = _load_policy_model(policy)
    if base_entry["status"] != "ok":
        return {**base_entry, "episodes_evaluated": 0, "metrics": None}, []

    episode_rows: list[dict[str, Any]] = []
    if planet_cfg.name == "default" and env_id != ENV_ID:
        env = gym.make(env_id)
    else:
        env = make_planet_env(planet_cfg.name, styled=False)
    try:
        n_actions = int(env.action_space.n) if policy.is_random else 0
        for seed in seeds:
            seed_int = int(seed)
            obs, _info = env.reset(seed=seed_int)
            rng = np.random.default_rng(seed_int) if policy.is_random else None

            prev_obs = obs
            had_leg_contact = bool(float(obs[6]) > 0.5 or float(obs[7]) > 0.5)
            td_vy: float | None = None
            td_speed: float | None = None
            total_reward = 0.0
            steps = 0
            terminated = False
            truncated = False

            while not (terminated or truncated):
                if policy.is_random:
                    assert rng is not None
                    action = int(rng.integers(0, n_actions))
                else:
                    assert model is not None
                    raw_action, _ = model.predict(obs, deterministic=deterministic)
                    action = int(np.asarray(raw_action).item())

                obs, reward, terminated, truncated, _info = env.step(action)
                total_reward += float(reward)
                steps += 1

                if td_vy is None:
                    cap_vy, cap_speed, had_leg_contact = extract_touchdown_metrics(
                        prev_obs, obs, had_leg_contact
                    )
                    if cap_vy is not None:
                        td_vy = cap_vy
                        td_speed = cap_speed

                prev_obs = obs

            unwrapped = env.unwrapped
            left_leg = bool(float(obs[6]) > 0.5)
            right_leg = bool(float(obs[7]) > 0.5)
            outcome = classify_episode_outcome(
                terminated=bool(terminated),
                truncated=bool(truncated),
                game_over=bool(unwrapped.game_over),
                lander_awake=bool(unwrapped.lander.awake),
                obs_x=float(obs[0]),
                lander_world_x=float(unwrapped.lander.position.x),
                helipad_x1=float(unwrapped.helipad_x1),
                helipad_x2=float(unwrapped.helipad_x2),
                left_leg_contact=left_leg,
                right_leg_contact=right_leg,
            )

            episode_rows.append(
                {
                    "policy": policy.name,
                    "seed": seed_int,
                    "reward": total_reward,
                    "steps": steps,
                    "outcome": outcome,
                    "touchdown_vertical_speed": td_vy,
                    "touchdown_speed": td_speed,
                    "final_x": float(obs[0]),
                    "final_y": float(obs[1]),
                    "final_angle": float(obs[4]),
                    "left_leg_contact": left_leg,
                    "right_leg_contact": right_leg,
                }
            )
    finally:
        env.close()

    metrics = aggregate_episode_results(episode_rows)
    summary_entry = {
        **base_entry,
        "episodes_evaluated": len(episode_rows),
        "metrics": metrics,
    }
    return summary_entry, episode_rows


def _get_package_version(dist_name: str) -> str:
    try:
        return importlib.metadata.version(dist_name)
    except importlib.metadata.PackageNotFoundError:
        return "not_installed"


def collect_run_metadata(
    *,
    env_id: str,
    seeds: Sequence[int],
    deterministic: bool,
    planet: str = "default",
) -> dict[str, Any]:
    """Build provenance and metric-definition metadata for benchmark_summary.json."""
    seed_list = [int(s) for s in seeds]
    planet_cfg = get_planet_config(planet)
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "env_id": env_id,
        "planet": planet_cfg.name,
        "planet_config": planet_cfg.to_metadata_dict(),
        "unshaped_evaluation": True,
        "deterministic": deterministic,
        "episodes": len(seed_list),
        "seed_start": seed_list[0] if seed_list else None,
        "seeds": seed_list,
        "solved_threshold": SOLVED_REWARD_THRESHOLD,
        "std_ddof": 0,
        "helipad_world_bounds_verified": {
            "helipad_x1": 8.0,
            "helipad_x2": 12.0,
            "attribute_names": [
                "env.unwrapped.helipad_x1",
                "env.unwrapped.helipad_x2",
                "env.unwrapped.lander.position.x",
            ],
            "normalized_x_equivalent": [-0.2, 0.2],
        },
        "touchdown_metric_definition": (
            "Captured from the pre-impact observation (prev_obs) on the first step where "
            "either leg transitions from no contact to ground contact (obs[6] > 0.5 or "
            "obs[7] > 0.5), avoiding Box2D contact-step damping and post-landing sleep zeroing. "
            "touchdown_vertical_speed = abs(prev_obs[3]); "
            "touchdown_speed = hypot(prev_obs[2], prev_obs[3]). "
            "Null if no leg contact occurred during the episode."
        ),
        "outcome_definitions": {
            "success_between_flags": (
                "terminated and not lander.awake (Box2D rest), not game_over, "
                "abs(obs[0]) < 1.0, both legs in contact, and "
                "helipad_x1 <= lander.position.x <= helipad_x2"
            ),
            "safe_outside_flags": (
                "terminated and not lander.awake (Box2D rest), not game_over, "
                "abs(obs[0]) < 1.0, outside flag bounds or fewer than two legs in contact"
            ),
            "crash": "env.unwrapped.game_over == True (lander body contacted ground)",
            "out_of_bounds": "abs(obs[0]) >= 1.0 with game_over == False",
            "timeout": "truncated == True and terminated == False (TimeLimit reached)",
        },
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "package_versions": {
            "gymnasium": _get_package_version("gymnasium"),
            "Box2D": _get_package_version("Box2D"),
            "stable-baselines3": _get_package_version("stable-baselines3"),
            "torch": _get_package_version("torch"),
            "numpy": _get_package_version("numpy"),
        },
    }


def _summary_entry_to_csv_row(entry: dict[str, Any]) -> dict[str, Any]:
    metrics = entry.get("metrics") or {}
    rates = metrics.get("outcome_rates_pct") or {}
    return {
        "policy": entry["policy"],
        "status": entry["status"],
        "error": "" if entry["error"] is None else entry["error"],
        "checkpoint_path": "" if entry["checkpoint_path"] is None else entry["checkpoint_path"],
        "num_timesteps": "" if entry["num_timesteps"] is None else entry["num_timesteps"],
        "episodes_evaluated": entry["episodes_evaluated"],
        "reward_mean": metrics.get("reward_mean", ""),
        "reward_std": metrics.get("reward_std", ""),
        "reward_min": metrics.get("reward_min", ""),
        "reward_median": metrics.get("reward_median", ""),
        "reward_max": metrics.get("reward_max", ""),
        "solved_rate_pct": metrics.get("solved_rate_pct", ""),
        "steps_mean": metrics.get("steps_mean", ""),
        "steps_std": metrics.get("steps_std", ""),
        "success_between_flags_pct": rates.get("success_between_flags", ""),
        "safe_outside_flags_pct": rates.get("safe_outside_flags", ""),
        "crash_pct": rates.get("crash", ""),
        "out_of_bounds_pct": rates.get("out_of_bounds", ""),
        "timeout_pct": rates.get("timeout", ""),
        "n_with_touchdown": metrics.get("n_with_touchdown", ""),
        "touchdown_vertical_speed_mean": (
            ""
            if metrics.get("touchdown_vertical_speed_mean") is None
            else metrics["touchdown_vertical_speed_mean"]
        ),
        "touchdown_vertical_speed_std": (
            ""
            if metrics.get("touchdown_vertical_speed_std") is None
            else metrics["touchdown_vertical_speed_std"]
        ),
        "touchdown_speed_mean": (
            ""
            if metrics.get("touchdown_speed_mean") is None
            else metrics["touchdown_speed_mean"]
        ),
        "touchdown_speed_std": (
            ""
            if metrics.get("touchdown_speed_std") is None
            else metrics["touchdown_speed_std"]
        ),
    }


def save_results(
    summary: dict[str, Any],
    episode_rows: list[dict[str, Any]],
    output_dir: str | Path,
    *,
    prefix: str = "benchmark",
    planet_meta: dict[str, Any] | None = None,
) -> dict[str, Path]:
    """Write ``<prefix>_summary.json``, ``<prefix>_summary.csv``, and ``<prefix>_episodes.csv``."""
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    summary_json_path = out_path / f"{prefix}_summary.json"
    summary_csv_path = out_path / f"{prefix}_summary.csv"
    episodes_csv_path = out_path / f"{prefix}_episodes.csv"

    with summary_json_path.open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    if planet_meta is not None:
        meta_cols = {k: planet_meta[k] for k in PLANET_META_CSV_FIELDS}
        sum_fields = PLANET_SUMMARY_CSV_FIELDS
        ep_fields = PLANET_EPISODE_CSV_FIELDS
    else:
        meta_cols = {}
        sum_fields = SUMMARY_CSV_FIELDS
        ep_fields = EPISODE_CSV_FIELDS

    with summary_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=sum_fields)
        writer.writeheader()
        for entry in summary["policies"].values():
            row = _summary_entry_to_csv_row(entry)
            if planet_meta is not None:
                row = {**meta_cols, **row}
            writer.writerow(row)

    with episodes_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=ep_fields)
        writer.writeheader()
        for row in episode_rows:
            out_row = {
                key: ("" if row[key] is None else row[key])
                for key in EPISODE_CSV_FIELDS
            }
            if planet_meta is not None:
                out_row = {"planet": planet_meta["planet"], **out_row}
            writer.writerow(out_row)

    return {
        "summary_json": summary_json_path,
        "summary_csv": summary_csv_path,
        "episodes_csv": episodes_csv_path,
    }


def save_planet_results(
    planet_summary: dict[str, Any],
    episode_rows: list[dict[str, Any]],
    output_dir: str | Path,
) -> dict[str, Path]:
    """Write consolidated cross-planet benchmark JSON and CSV files."""
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    summary_json_path = out_path / "planet_benchmark_summary.json"
    summary_csv_path = out_path / "planet_benchmark_summary.csv"
    episodes_csv_path = out_path / "planet_benchmark_episodes.csv"

    with summary_json_path.open("w", encoding="utf-8") as f:
        json.dump(planet_summary, f, indent=2)

    with summary_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=PLANET_SUMMARY_CSV_FIELDS)
        writer.writeheader()
        for planet_block in planet_summary["planets"].values():
            p_cfg = planet_block["planet_config"]
            meta_cols = {k: p_cfg[k] for k in PLANET_META_CSV_FIELDS}
            for entry in planet_block["policies"].values():
                writer.writerow({**meta_cols, **_summary_entry_to_csv_row(entry)})

    with episodes_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=PLANET_EPISODE_CSV_FIELDS)
        writer.writeheader()
        for row in episode_rows:
            writer.writerow(
                {
                    key: ("" if row[key] is None else row[key])
                    for key in PLANET_EPISODE_CSV_FIELDS
                }
            )

    return {
        "summary_json": summary_json_path,
        "summary_csv": summary_csv_path,
        "episodes_csv": episodes_csv_path,
    }


def run_benchmark(
    *,
    policies: Sequence[PolicySpec] = DEFAULT_POLICIES,
    episodes: int = 100,
    seed_start: int = 42,
    output_dir: str | Path | None = "results",
    env_id: str = ENV_ID,
    deterministic: bool = True,
    planet: str = "default",
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Path] | None]:
    """Run the full multi-policy benchmark across identical seeds and optionally save outputs."""
    if episodes < 1:
        raise ValueError(f"episodes must be >= 1, got {episodes}")

    planet_cfg = get_planet_config(planet)
    seeds = list(range(seed_start, seed_start + episodes))
    metadata = collect_run_metadata(
        env_id=env_id,
        seeds=seeds,
        deterministic=deterministic,
        planet=planet_cfg.name,
    )

    policy_summaries: dict[str, Any] = {}
    all_episodes: list[dict[str, Any]] = []

    for policy in policies:
        entry, ep_rows = evaluate_policy(
            policy,
            seeds,
            env_id=env_id,
            deterministic=deterministic,
            planet=planet_cfg.name,
        )
        policy_summaries[policy.name] = entry
        all_episodes.extend(ep_rows)

    summary = {
        "metadata": metadata,
        "policies": policy_summaries,
    }
    if output_dir is None:
        saved_paths = None
    elif planet_cfg.name == "default":
        saved_paths = save_results(summary, all_episodes, output_dir)
    else:
        saved_paths = save_results(
            summary,
            all_episodes,
            output_dir,
            prefix=f"{planet_cfg.name}_benchmark",
            planet_meta=planet_cfg.to_metadata_dict(),
        )
    return summary, all_episodes, saved_paths


def run_planet_benchmark(
    *,
    policies: Sequence[PolicySpec] = DEFAULT_POLICIES,
    planets: Sequence[str] = PLANETARY_PRESETS,
    episodes: int = 100,
    seed_start: int = 42,
    output_dir: str | Path | None = "results",
    env_id: str = ENV_ID,
    deterministic: bool = True,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Path] | None]:
    """Run fixed-seed multi-policy benchmark across multiple planetary presets."""
    if episodes < 1:
        raise ValueError(f"episodes must be >= 1, got {episodes}")

    resolved_cfgs = [get_planet_config(p) for p in planets]
    seeds = list(range(seed_start, seed_start + episodes))
    base_meta = collect_run_metadata(
        env_id=env_id,
        seeds=seeds,
        deterministic=deterministic,
        planet="default",
    )
    base_meta["planet"] = "all-planets"
    base_meta["planets"] = [cfg.name for cfg in resolved_cfgs]
    base_meta["planet_configs"] = {
        cfg.name: cfg.to_metadata_dict() for cfg in resolved_cfgs
    }
    base_meta.pop("planet_config", None)

    planets_payload: dict[str, Any] = {}
    all_episodes: list[dict[str, Any]] = []

    for cfg in resolved_cfgs:
        policy_summaries: dict[str, Any] = {}
        for policy in policies:
            entry, ep_rows = evaluate_policy(
                policy,
                seeds,
                env_id=env_id,
                deterministic=deterministic,
                planet=cfg.name,
            )
            policy_summaries[policy.name] = entry
            for row in ep_rows:
                all_episodes.append({"planet": cfg.name, **row})
        planets_payload[cfg.name] = {
            "planet_config": cfg.to_metadata_dict(),
            "policies": policy_summaries,
        }

    planet_summary = {
        "metadata": base_meta,
        "planets": planets_payload,
    }
    saved_paths = (
        save_planet_results(planet_summary, all_episodes, output_dir)
        if output_dir is not None
        else None
    )
    return planet_summary, all_episodes, saved_paths


def _format_policy_row(name: str, entry: dict[str, Any]) -> list[str]:
    m = entry.get("metrics")
    if m is None:
        return [name, entry["status"], "0", "-", "-", "-", "-", "-", "-", "-", "-", "-"]
    r = m["outcome_rates_pct"]
    if m["touchdown_vertical_speed_mean"] is not None:
        td_str = f"{m['touchdown_vertical_speed_mean']:.3f} ({m['n_with_touchdown']})"
    else:
        td_str = f"null ({m['n_with_touchdown']})"
    return [
        name,
        entry["status"],
        str(m["episodes_evaluated"]),
        f"{m['reward_mean']:.2f} +/- {m['reward_std']:.2f}",
        f"{m['reward_median']:.2f} [{m['reward_min']:.1f}, {m['reward_max']:.1f}]",
        f"{m['solved_rate_pct']:.1f}%",
        f"{r['success_between_flags']:.1f}%",
        f"{r['safe_outside_flags']:.1f}%",
        f"{r['crash']:.1f}%",
        f"{r['out_of_bounds']:.1f}%",
        f"{r['timeout']:.1f}%",
        td_str,
    ]


def _align_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [max(len(headers[i]), *(len(row[i]) for row in rows)) for i in range(len(headers))]
    fmt_row = lambda cols: " | ".join(col.ljust(widths[i]) for i, col in enumerate(cols))
    sep = "-+-".join("-" * w for w in widths)
    return "\n".join([fmt_row(headers), sep, *(fmt_row(r) for r in rows)])


def format_summary_table(summary: dict[str, Any]) -> str:
    """Format a readable summary table for terminal output."""
    headers = [
        "Policy",
        "Status",
        "N",
        "Mean +/- Std",
        "Median [Min, Max]",
        "Solved%",
        "Flags%",
        "SafeOut%",
        "Crash%",
        "OOB%",
        "Time%",
        "TD |vy| (n)",
    ]
    rows = [_format_policy_row(name, entry) for name, entry in summary["policies"].items()]
    return _align_table(headers, rows)


def format_planet_summary_table(planet_summary: dict[str, Any]) -> str:
    """Format a consolidated cross-planet summary table for terminal output."""
    headers = [
        "Planet",
        "Policy",
        "Status",
        "N",
        "Mean +/- Std",
        "Median [Min, Max]",
        "Solved%",
        "Flags%",
        "SafeOut%",
        "Crash%",
        "OOB%",
        "Time%",
        "TD |vy| (n)",
    ]
    rows: list[list[str]] = []
    for planet_name, block in planet_summary["planets"].items():
        for policy_name, entry in block["policies"].items():
            rows.append([planet_name, *_format_policy_row(policy_name, entry)])
    return _align_table(headers, rows)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for benchmark execution."""
    parser = argparse.ArgumentParser(
        description="Run deterministic multi-policy benchmark on unshaped LunarLander-v3."
    )
    parser.add_argument(
        "--planet",
        choices=(*PLANET_CHOICES, "all-planets"),
        default="default",
        help="Planetary preset to evaluate, or 'all-planets' for Moon+Mars+Earth (default: default).",
    )
    parser.add_argument(
        "--episodes",
        type=int,
        default=100,
        help="Number of fixed-seed episodes per policy (default: 100).",
    )
    parser.add_argument(
        "--seed-start",
        type=int,
        default=42,
        help="Starting episode seed; evaluates [seed_start .. seed_start + episodes - 1] (default: 42).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="results",
        help="Directory to write JSON/CSV benchmark artifacts (default: results).",
    )
    parser.add_argument(
        "--policies",
        nargs="+",
        choices=[p.name for p in DEFAULT_POLICIES],
        default=None,
        help="Subset of policies to evaluate (default: all four).",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    args = parse_args(argv)
    if args.episodes < 1:
        raise SystemExit("--episodes must be >= 1")

    selected = (
        tuple(p for p in DEFAULT_POLICIES if p.name in args.policies)
        if args.policies
        else DEFAULT_POLICIES
    )
    if args.planet == "all-planets":
        planet_summary, _episodes, saved = run_planet_benchmark(
            policies=selected,
            planets=PLANETARY_PRESETS,
            episodes=args.episodes,
            seed_start=args.seed_start,
            output_dir=args.output_dir,
        )
        meta = planet_summary["metadata"]
        print(
            f"\nCross-Planet Benchmark: env={meta['env_id']} (unshaped), "
            f"planets={','.join(meta['planets'])}, episodes={meta['episodes']}, "
            f"seeds={meta['seed_start']}..{meta['seed_start'] + meta['episodes'] - 1}, "
            f"deterministic={meta['deterministic']}"
        )
        print(format_planet_summary_table(planet_summary))
    else:
        summary, _episodes, saved = run_benchmark(
            policies=selected,
            episodes=args.episodes,
            seed_start=args.seed_start,
            output_dir=args.output_dir,
            planet=args.planet,
        )
        meta = summary["metadata"]
        print(
            f"\nBenchmark: env={meta['env_id']} (planet={meta['planet']}, unshaped), "
            f"episodes={meta['episodes']}, "
            f"seeds={meta['seed_start']}..{meta['seed_start'] + meta['episodes'] - 1}, "
            f"deterministic={meta['deterministic']}"
        )
        print(format_summary_table(summary))

    if saved:
        print("\nSaved artifacts:")
        for key, path in saved.items():
            print(f"  {key}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
