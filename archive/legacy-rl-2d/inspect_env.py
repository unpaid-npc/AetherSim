import gymnasium as gym
import numpy as np

# We don't need render_mode="human" here because we just want the data
env = gym.make("LunarLander-v3")

print("--- ACTION SPACE ---")
print(f"Type: {env.action_space}")
print("0: Do nothing")
print("1: Fire left orientation engine")
print("2: Fire main engine")
print("3: Fire right orientation engine")

print("\n--- OBSERVATION SPACE ---")
print(f"Type: {env.observation_space}")
# The bounds tell us the maximum and minimum possible values for each of the 8 variables
print(f"High bounds: {np.round(env.observation_space.high, 2)}")
print(f"Low bounds:  {np.round(env.observation_space.low, 2)}")

# Reset the environment to get a sample observation
obs, info = env.reset()
print("\n--- SAMPLE OBSERVATION (Initial State) ---")
print(np.round(obs, 3))
print("Vector mapping: [x, y, v_x, v_y, angle, v_angle, left_leg_contact, right_leg_contact]")

env.close()