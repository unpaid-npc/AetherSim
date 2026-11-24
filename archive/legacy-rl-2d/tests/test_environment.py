"""Tests for Gymnasium LunarLander-v3 environment contract and seed determinism."""

from __future__ import annotations

import gymnasium as gym
import numpy as np


def test_lunar_lander_spaces() -> None:
    env = gym.make("LunarLander-v3")
    try:
        assert isinstance(env.observation_space, gym.spaces.Box)
        assert env.observation_space.shape == (8,)
        assert env.observation_space.dtype == np.float32
        assert isinstance(env.action_space, gym.spaces.Discrete)
        assert int(env.action_space.n) == 4
    finally:
        env.close()


def test_lunar_lander_seed_determinism_and_step_tuple() -> None:
    env = gym.make("LunarLander-v3")
    try:
        obs1, info1 = env.reset(seed=42)
        obs2, info2 = env.reset(seed=42)

        assert np.array_equal(obs1, obs2)
        assert isinstance(info1, dict)
        assert isinstance(info2, dict)

        step_result = env.step(0)
        assert len(step_result) == 5
        obs, reward, terminated, truncated, info = step_result

        assert isinstance(obs, np.ndarray)
        assert obs.shape == (8,)
        assert obs.dtype == np.float32
        assert np.isfinite(float(reward))
        assert isinstance(terminated, bool)
        assert isinstance(truncated, bool)
        assert isinstance(info, dict)
    finally:
        env.close()
