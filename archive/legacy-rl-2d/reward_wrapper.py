import gymnasium as gym

class ShapingRewardWrapper(gym.Wrapper):
    def __init__(self, env):
        super().__init__(env)

    def step(self, action):
        # 1. Take a step in the base environment
        obs, reward, terminated, truncated, info = self.env.step(action)
        
        # 2. Extract the physical state variables from the observation array
        x, y, v_x, v_y, angle, v_angle, left_contact, right_contact = obs
        
        # 3. APPLY REWARD SHAPING
        
        # Penalty A: Discourage tilting. The rocket should stay strictly upright.
        # The angle is in radians. We subtract a fraction of the absolute angle.
        reward -= abs(angle) * 0.5 
        
        # Penalty B: Discourage horizontal drifting.
        # We want the agent to stay aligned with the landing pad at x=0.
        reward -= abs(x) * 0.1
        
        return obs, reward, terminated, truncated, info