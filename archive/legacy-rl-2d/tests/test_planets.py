"""Tests for planetary configurations, physics differentiation, visuals, and benchmarks."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np
import pytest

import benchmark
from planets import (
    PLANET_CHOICES,
    PLANETARY_PRESETS,
    PLANETS,
    PlanetaryVisualWrapper,
    get_planet_config,
    make_planet_env,
)


def test_planet_registry_and_valid_box2d_ranges() -> None:
    assert set(PLANETS.keys()) == set(PLANET_CHOICES)
    for name, cfg in PLANETS.items():
        assert cfg.name == name
        assert -12.0 < cfg.gravity < 0.0
        assert cfg.wind_power >= 0.0
        assert cfg.turbulence_power >= 0.0
        assert cfg.real_gravity_mps2 > 0.0

    moon, mars, earth = (PLANETS[p] for p in PLANETARY_PRESETS)
    assert len({moon.gravity, mars.gravity, earth.gravity}) == 3
    assert moon.enable_wind is False
    assert mars.enable_wind is True and earth.enable_wind is True
    assert moon.wind_power < mars.wind_power < earth.wind_power
    assert moon.theme is not None and mars.theme is not None and earth.theme is not None
    assert len({moon.theme.sky_mid_rgb, mars.theme.sky_mid_rgb, earth.theme.sky_mid_rgb}) == 3
    assert (
        len(
            {
                moon.theme.terrain_fill_rgb,
                mars.theme.terrain_fill_rgb,
                earth.theme.terrain_fill_rgb,
            }
        )
        == 3
    )


def test_get_planet_config_case_insensitive_and_invalid() -> None:
    assert get_planet_config("MARS").name == "mars"
    assert get_planet_config("  Earth ").name == "earth"
    with pytest.raises(ValueError, match="Unknown planet"):
        get_planet_config("jupiter")


def test_planetary_physics_gravity_differentiation() -> None:
    final_states: dict[str, np.ndarray] = {}
    for planet in PLANETARY_PRESETS:
        env = make_planet_env(planet, styled=False)
        try:
            obs, _ = env.reset(seed=42)
            for _ in range(20):
                obs, _r, term, trunc, _ = env.step(0)
                if term or trunc:
                    break
            final_states[planet] = obs
        finally:
            env.close()

    # Stronger downward gravity produces lower altitude (obs[1]) and faster downward vy (obs[3])
    assert final_states["earth"][1] < final_states["mars"][1] < final_states["moon"][1]
    assert final_states["earth"][3] < final_states["mars"][3] < final_states["moon"][3]


def test_planetary_visual_differentiation() -> None:
    frames: dict[str, np.ndarray] = {}
    for planet in PLANETARY_PRESETS:
        env = make_planet_env(planet, render_mode="rgb_array", styled=True)
        try:
            env.reset(seed=42)
            env.step(2)
            frame = env.render()
            assert isinstance(frame, np.ndarray)
            assert frame.shape == (400, 600, 3)
            assert frame.dtype == np.uint8
            frames[planet] = frame
        finally:
            env.close()

    # Pairwise visual distinction across the full frame
    for p1, p2 in (("moon", "mars"), ("mars", "earth"), ("moon", "earth")):
        diff = float(np.mean(np.abs(frames[p1].astype(np.int16) - frames[p2].astype(np.int16))))
        assert diff > 20.0, f"Frames for {p1} and {p2} too similar (diff={diff:.2f})"

    # Verify sky band color signatures (top right sky band, avoiding top-left HUD)
    mars_sky = frames["mars"][20:100, 420:580].mean(axis=(0, 1))
    earth_sky = frames["earth"][20:100, 420:580].mean(axis=(0, 1))
    moon_sky = frames["moon"][20:100, 420:580].mean(axis=(0, 1))
    assert mars_sky[0] > mars_sky[2]  # dusty rust/ochre: R > B
    assert earth_sky[2] > earth_sky[0]  # sky blue: B > R
    assert moon_sky.mean() < 25.0 and moon_sky.mean() < mars_sky.mean() and moon_sky.mean() < earth_sky.mean()


def test_planetary_visual_wrapper_invariance() -> None:
    env_styled = make_planet_env("mars", render_mode="rgb_array", styled=True)
    env_plain = make_planet_env("mars", render_mode=None, styled=False)
    try:
        assert isinstance(env_styled, PlanetaryVisualWrapper)
        assert env_styled.observation_space == env_plain.observation_space
        assert env_styled.action_space == env_plain.action_space

        obs_s, _ = env_styled.reset(seed=42)
        obs_p, _ = env_plain.reset(seed=42)
        assert np.array_equal(obs_s, obs_p)

        actions = [2, 2, 1, 0, 3, 2, 0, 1, 2, 3, 0, 2, 2, 1, 0]
        for action in actions:
            obs_s, r_s, term_s, trunc_s, _ = env_styled.step(action)
            _ = env_styled.render()
            obs_p, r_p, term_p, trunc_p, _ = env_plain.step(action)
            assert np.array_equal(obs_s, obs_p)
            assert r_s == r_p
            assert term_s == term_p
            assert trunc_s == trunc_p
            if term_p or trunc_p:
                break
    finally:
        env_styled.close()
        env_plain.close()


def test_default_planet_unwrapped_and_planet_benchmark_roundtrip(tmp_path: Path) -> None:
    env_def = make_planet_env("default", render_mode="rgb_array", styled=True)
    try:
        assert not isinstance(env_def, PlanetaryVisualWrapper)
    finally:
        env_def.close()

    summary, episodes, saved = benchmark.run_planet_benchmark(
        policies=(benchmark.DEFAULT_POLICIES[0],),
        planets=PLANETARY_PRESETS,
        episodes=1,
        seed_start=42,
        output_dir=tmp_path,
    )
    assert saved is not None
    assert len(episodes) == 3

    parsed = json.loads(saved["summary_json"].read_text(encoding="utf-8"))
    assert parsed["metadata"]["planets"] == list(PLANETARY_PRESETS)
    for planet in PLANETARY_PRESETS:
        assert parsed["planets"][planet]["policies"]["random_baseline"]["status"] == "ok"

    with saved["summary_csv"].open("r", encoding="utf-8", newline="") as f:
        sum_rows = list(csv.DictReader(f))
    assert len(sum_rows) == 3
    assert [r["planet"] for r in sum_rows] == list(PLANETARY_PRESETS)

    with saved["episodes_csv"].open("r", encoding="utf-8", newline="") as f:
        ep_rows = list(csv.DictReader(f))
    assert len(ep_rows) == 3
    assert set(r["planet"] for r in ep_rows) == set(PLANETARY_PRESETS)
