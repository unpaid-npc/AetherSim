import gymnasium as gym
from stable_baselines3 import PPO
import numpy as np

# 1. Load the environment with graphics enabled so we can watch
env = gym.make("LunarLander-v3", render_mode="human")

# 2. Load the trained weights
model_path = "models/PPO/ppo_lunarlander_100k.zip"
print(f"Loading model from {model_path}...")
model = PPO.load(model_path, env=env)

episodes = 5
episode_rewards = []

# 3. The Evaluation Loop
for ep in range(episodes):
    # Using a fixed seed ensures the terrain and starting physics are the same every time we run this script
    obs, info = env.reset(seed=42 + ep) 
    done = False
    total_reward = 0
    
    while not done:
        # deterministic=True removes exploration noise. The agent uses its exact learned policy.
        action, _states = model.predict(obs, deterministic=True)
        
        obs, reward, terminated, truncated, info = env.step(action)
        total_reward += reward
        done = terminated or truncated
        
    episode_rewards.append(total_reward)
    print(f"Episode {ep + 1} Reward: {total_reward:.2f}")

env.close()

# 4. Final Statistics
print("\n--- TRAINED MODEL EVALUATION ---")
print(f"Mean Reward: {np.mean(episode_rewards):.2f}")
print(f"Std Reward: {np.std(episode_rewards):.2f}")