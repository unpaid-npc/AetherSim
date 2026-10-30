import gymnasium as gym
from stable_baselines3 import PPO
import os

# 1. Setup paths for logging and saving
models_dir = "models/PPO"
logdir = "logs"

os.makedirs(models_dir, exist_ok=True)
os.makedirs(logdir, exist_ok=True)

# 2. Initialize the environment
# We don't render graphics during training so it runs at maximum CPU speed
env = gym.make("LunarLander-v3")

# 3. Initialize the PPO Model
# "MlpPolicy": Standard feed-forward neural network
# verbose=1: Prints out training metrics to the terminal
# tensorboard_log: Saves math data for us to plot later
print("Initializing PPO Neural Network...")
model = PPO("MlpPolicy", env, verbose=1, tensorboard_log=logdir)

# 4. Train the Model
# 100,000 timesteps is a small "test run". It won't perfectly solve the environment, 
# but it will show clear signs of learning.
TIMESTEPS = 100000
print(f"Starting training for {TIMESTEPS} timesteps...")
model.learn(total_timesteps=TIMESTEPS, reset_num_timesteps=False, tb_log_name="PPO")

# 5. Save the trained weights
model_path = f"{models_dir}/ppo_lunarlander_100k"
model.save(model_path)
print(f"Model saved to {model_path}.zip")

env.close()