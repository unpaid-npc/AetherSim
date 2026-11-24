import gymnasium as gym

# 1. Initialize the environment
# render_mode="human" tells it to open a window so we can watch
env = gym.make("LunarLander-v3", render_mode="human")

# 2. Reset the environment to start a new episode
# This returns the initial state (observation) and an info dictionary
observation, info = env.reset()

print("Environment initialized. Starting random agent...")

# 3. The RL Loop
for step in range(300):
    # Sample a totally random action from the environment's action space
    action = env.action_space.sample()
    
    # Pass the action to the environment
    # It returns the new state, the reward, and whether the episode is over
    observation, reward, terminated, truncated, info = env.step(action)
    
    # If the rocket crashes or lands safely, reset the environment
    if terminated or truncated:
        print(f"Episode ended after {step} steps. Resetting...")
        observation, info = env.reset()

# 4. Cleanup
env.close()
print("Simulation closed.")