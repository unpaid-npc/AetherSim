"""Tests for ShapingRewardWrapper reward shaping and pass-through semantics."""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np
import pytest

from reward_wrapper import ShapingRewardWrapper


class _DummyLanderEnv(gym.Env):
    """Minimal mock environment returning deterministic observation and reward."""

    def __init__(
        self,
        *,
        obs: np.ndarray,
        base_reward: float = 1.5,
        terminated: bool = False,
        truncated: bool = False,
        info: dict[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self.observation_space = gym.spaces.Box(
            low=-10.0, high=10.0, shape=(8,), dtype=np.float32
        )
        self.action_space = gym.spaces.Discrete(4)
        self._obs = obs
        self._base_reward = base_reward
        self._terminated = terminated
        self._truncated = truncated
        self._info = info if info is not None else {"source": "dummy"}

    def reset(
        self, *, seed: int | None = None, options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        return self._obs.copy(), dict(self._info)

    def step(
        self, action: int
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        return (
            self._obs.copy(),
            float(self._base_reward),
            self._terminated,
            self._truncated,
            dict(self._info),
        )


@pytest.mark.parametrize(
    ("x", "angle", "base_reward", "expected_reward", "terminated", "truncated"),
    [
        (0.0, 0.0, 2.5, 2.5, False, False),
        (0.0, 0.4, 2.5, 2.5 - 0.2, False, False),
        (0.0, -0.6, 2.5, 2.5 - 0.3, True, False),
        (0.5, 0.0, 2.5, 2.5 - 0.05, False, True),
        (-0.8, 0.0, 2.5, 2.5 - 0.08, False, False),
        (-0.5, 0.4, 2.5, 2.5 - 0.25, True, False),
    ],
)
def test_shaping_reward_wrapper_penalties(
    x: float,
    angle: float,
    base_reward: float,
    expected_reward: float,
    terminated: bool,
    truncated: bool,
) -> None:
    obs_in = np.array([x, 0.5, 0.1, -0.2, angle, 0.05, 0.0, 1.0], dtype=np.float32)
    info_in = {"marker": "preserve_me"}
    dummy = _DummyLanderEnv(
        obs=obs_in,
        base_reward=base_reward,
        terminated=terminated,
        truncated=truncated,
        info=info_in,
    )
    wrapped = ShapingRewardWrapper(dummy)

    obs_out, reward_out, term_out, trunc_out, info_out = wrapped.step(2)

    assert np.array_equal(obs_out, obs_in)
    assert reward_out == pytest.approx(expected_reward, abs=1e-6)
    assert term_out is terminated
    assert trunc_out is truncated
    assert info_out == info_in


def test_shaping_reward_wrapper_with_lunar_lander() -> None:
    base_env = gym.make("LunarLander-v3")
    wrapped = ShapingRewardWrapper(base_env)
    try:
        assert wrapped.observation_space == base_env.observation_space
        assert wrapped.action_space == base_env.action_space

        obs, info = wrapped.reset(seed=42)
        assert obs.shape == (8,)
        assert isinstance(info, dict)

        step_obs, reward, terminated, truncated, step_info = wrapped.step(0)
        assert step_obs.shape == (8,)
        assert np.isfinite(float(reward))
        assert isinstance(terminated, bool)
        assert isinstance(truncated, bool)
        assert isinstance(step_info, dict)
    finally:
        wrapped.close()
