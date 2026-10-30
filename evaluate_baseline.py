import gymnasium as gym
import numpy as np

def evaluate_random_agent(episodes=100):
    # Notice we removed render_mode="human". 
    # Without rendering graphics, 100 episodes will simulate in seconds.
    env = gym.make("LunarLander-v3")
    episode_rewards = []

    print(f"Simulating {episodes} episodes with a random agent...")

    for ep in range(episodes):
        obs, info = env.reset()
        total_reward = 0
        done = False
        
        while not done:
            action = env.action_space.sample() # Purely random action
            obs, reward, terminated, truncated, info = env.step(action)
            total_reward += reward
            done = terminated or truncated
            
        episode_rewards.append(total_reward)
        
    env.close()
    
    # Calculate statistics using numpy
    mean_reward = np.mean(episode_rewards)
    std_reward = np.std(episode_rewards)
    
    print("\n--- RANDOM AGENT BASELINE RESULTS ---")
    print(f"Episodes: {episodes}")
    print(f"Mean Reward: {mean_reward:.2f}")
    print(f"Standard Deviation: {std_reward:.2f}")
    print(f"Min Reward (Worst crash): {np.min(episode_rewards):.2f}")
    print(f"Max Reward (Best luck): {np.max(episode_rewards):.2f}")

if __name__ == "__main__":
    evaluate_random_agent()