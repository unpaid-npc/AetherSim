import gymnasium as gym
from stable_baselines3 import PPO
import os
from reward_wrapper import ShapingRewardWrapper

models_dir = "models/PPO_Shaped"
logdir = "logs"
os.makedirs(models_dir, exist_ok=True)

# 1. Initialize the environment and apply our custom wrapper
base_env = gym.make("LunarLander-v3")
env = ShapingRewardWrapper(base_env)

# 2. Initialize a fresh PPO model
print("Initializing PPO with Custom Reward Shaping...")
model = PPO("MlpPolicy", env, verbose=1, tensorboard_log=logdir)

# 3. Train for 500,000 timesteps
# 100k was just a test. 500k gives the network enough experience to truly master the physics.
TIMESTEPS = 500000
print(f"Starting full training run for {TIMESTEPS} timesteps...")
model.learn(total_timesteps=TIMESTEPS, reset_num_timesteps=False, tb_log_name="PPO_Shaped")

# 4. Save the fully trained model
model_path = f"{models_dir}/ppo_lunarlander_shaped_500k"
model.save(model_path)
print(f"Model saved to {model_path}.zip")

env.close()