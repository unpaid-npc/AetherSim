import gymnasium as gym
from stable_baselines3 import PPO
import numpy as np

# 1. Initialize the base environment (no shaping penalties!)
# render_mode="rgb_array" is required for video recording
base_env = gym.make("LunarLander-v3", render_mode="rgb_array")

# 2. Wrap the environment to record video of every episode
env = gym.wrappers.RecordVideo(
    base_env, 
    video_folder="videos", 
    name_prefix="shaped_lander",
    episode_trigger=lambda x: True # Record all episodes
)

# 3. Load the fully trained shaped model
model_path = "models/PPO_Shaped/ppo_lunarlander_shaped_500k.zip"
print(f"Loading model from {model_path}...")
model = PPO.load(model_path, env=env)

episodes = 5
episode_rewards = []

# 4. Evaluation Loop
for ep in range(episodes):
    obs, info = env.reset(seed=42 + ep)
    done = False
    total_reward = 0
    
    while not done:
        # deterministic=True ensures the agent uses its optimal learned policy
        action, _ = model.predict(obs, deterministic=True)
        obs, reward, terminated, truncated, info = env.step(action)
        total_reward += reward
        done = terminated or truncated
        
    episode_rewards.append(total_reward)
    print(f"Episode {ep + 1} Reward: {total_reward:.2f}")

env.close()

# 5. Final Statistics
print("\n--- FINAL TRAINED MODEL EVALUATION ---")
print(f"Mean Reward: {np.mean(episode_rewards):.2f}")
print(f"Std Reward: {np.std(episode_rewards):.2f}")