import gymnasium as gym
from stable_baselines3 import PPO
import os
from reward_wrapper import ShapingRewardWrapper

models_dir = "models/PPO_Final"
logdir = "logs"
os.makedirs(models_dir, exist_ok=True)

# 1. Initialize environment with our custom wrapper
base_env = gym.make("LunarLander-v3")
env = ShapingRewardWrapper(base_env)

# 2. Load the existing 500k checkpoint instead of starting from scratch
model_path = "models/PPO_Shaped/ppo_lunarlander_shaped_500k.zip"
print(f"Loading checkpoint from {model_path}...")
model = PPO.load(model_path, env=env, tensorboard_log=logdir)

# 3. Train for another 500,000 steps (reaching 1 Million total)
# reset_num_timesteps=False ensures TensorBoard continues the same graph
TIMESTEPS = 500000
print("Continuing training for 500,000 more timesteps...")
model.learn(total_timesteps=TIMESTEPS, reset_num_timesteps=False, tb_log_name="PPO_Final")

# 4. Save the 1 Million step model
final_model_path = f"{models_dir}/ppo_lunarlander_final_1M"
model.save(final_model_path)
print(f"Final 1M step model saved to {final_model_path}.zip")

env.close()