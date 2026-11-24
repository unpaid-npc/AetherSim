"""Interactive and video-recording CLI runner for planetary LunarLander presets."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

import gymnasium as gym
import numpy as np
from stable_baselines3 import PPO

from benchmark import classify_episode_outcome, extract_touchdown_metrics
from planets import PLANET_CHOICES, get_planet_config, make_planet_env


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for the planetary demo runner."""
    parser = argparse.ArgumentParser(
        description="Run or record a planetary LunarLander-v3 policy rollout."
    )
    parser.add_argument(
        "--planet",
        choices=PLANET_CHOICES,
        default="mars",
        help="Planetary preset to run (default: mars).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="models/PPO_Final/ppo_lunarlander_final_1M.zip",
        help="Path to Stable-Baselines3 PPO checkpoint .zip.",
    )
    parser.add_argument(
        "--random",
        action="store_true",
        help="Use reproducible random actions instead of a PPO checkpoint.",
    )
    parser.add_argument(
        "--episodes",
        type=int,
        default=1,
        help="Number of episodes to run (default: 1).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Starting episode seed (default: 42).",
    )
    parser.add_argument(
        "--mode",
        choices=("record", "human"),
        default="record",
        help="Execution mode: record MP4 clips or display live Pygame window (default: record).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Optional video output directory in record mode (default: videos/planets/<planet>).",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.episodes < 1:
        raise SystemExit("--episodes must be >= 1")

    cfg = get_planet_config(args.planet)
    model: PPO | None = None
    if not args.random:
        ckpt_path = Path(args.model)
        if not ckpt_path.is_file():
            raise SystemExit(f"Checkpoint not found: {ckpt_path}")
        model = PPO.load(str(ckpt_path), device="cpu")

    policy_tag = "random" if args.random else Path(args.model).stem
    render_mode = "rgb_array" if args.mode == "record" else "human"
    env = make_planet_env(
        cfg.name,
        render_mode=render_mode,
        styled=(cfg.name != "default"),
    )

    video_dir: Path | None = None
    if args.mode == "record":
        video_dir = (
            Path(args.output_dir)
            if args.output_dir is not None
            else Path("videos") / "planets" / cfg.name
        )
        video_dir.mkdir(parents=True, exist_ok=True)
        env = gym.wrappers.RecordVideo(
            env,
            video_folder=str(video_dir),
            name_prefix=f"{cfg.name}_{policy_tag}",
            episode_trigger=lambda _ep_idx: True,
        )

    print(
        f"Planet: {cfg.display_name} ({cfg.name}) | "
        f"gravity={cfg.gravity:.2f} (real={cfg.real_gravity_mps2:.2f} m/s^2) | "
        f"atmosphere={cfg.atmosphere_label} | "
        f"wind={cfg.enable_wind} (power={cfg.wind_power}, turb={cfg.turbulence_power})"
    )
    print(f"Policy: {'random_baseline' if args.random else args.model} | Mode: {args.mode}")

    try:
        n_actions = int(env.action_space.n) if args.random else 0
        for ep in range(args.episodes):
            ep_seed = args.seed + ep
            obs, _info = env.reset(seed=ep_seed)
            rng = np.random.default_rng(ep_seed) if args.random else None

            prev_obs = obs
            had_leg_contact = bool(float(obs[6]) > 0.5 or float(obs[7]) > 0.5)
            td_vy: float | None = None
            total_reward = 0.0
            steps = 0
            terminated = False
            truncated = False

            while not (terminated or truncated):
                if args.random:
                    assert rng is not None
                    action = int(rng.integers(0, n_actions))
                else:
                    assert model is not None
                    raw_action, _ = model.predict(obs, deterministic=True)
                    action = int(np.asarray(raw_action).item())

                obs, reward, terminated, truncated, _info = env.step(action)
                total_reward += float(reward)
                steps += 1

                if td_vy is None:
                    cap_vy, _cap_spd, had_leg_contact = extract_touchdown_metrics(
                        prev_obs, obs, had_leg_contact
                    )
                    if cap_vy is not None:
                        td_vy = cap_vy
                prev_obs = obs

            unwrapped = env.unwrapped
            outcome = classify_episode_outcome(
                terminated=bool(terminated),
                truncated=bool(truncated),
                game_over=bool(unwrapped.game_over),
                lander_awake=bool(unwrapped.lander.awake),
                obs_x=float(obs[0]),
                lander_world_x=float(unwrapped.lander.position.x),
                helipad_x1=float(unwrapped.helipad_x1),
                helipad_x2=float(unwrapped.helipad_x2),
                left_leg_contact=bool(float(obs[6]) > 0.5),
                right_leg_contact=bool(float(obs[7]) > 0.5),
            )
            td_str = f"{td_vy:.3f}" if td_vy is not None else "null"
            print(
                f"  Episode {ep + 1} (seed={ep_seed}): reward={total_reward:.2f}, "
                f"steps={steps}, outcome={outcome}, td_|vy|={td_str}"
            )
    finally:
        env.close()

    if video_dir is not None:
        clips = sorted(video_dir.glob(f"{cfg.name}_{policy_tag}-episode-*.mp4"))
        print("Recorded video clips:")
        for clip in clips:
            print(f"  {clip} ({clip.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
