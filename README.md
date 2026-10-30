# RL Rocket Landing Policy

This project trains a neural network to land a simulated rocket using Reinforcement Learning. It uses Proximal Policy Optimization (PPO) to learn flight dynamics and custom reward shaping to ensure the agent lands safely within a designated target area.

## Tech Stack
* **Language:** Python
* **RL Algorithm:** Proximal Policy Optimization (PPO) via Stable-Baselines3
* **Environment:** Farama Gymnasium (LunarLander-v3, Box2D physics)
* **Tracking:** TensorBoard

## Training Methodology
1. **Baseline Evaluation:** A purely random agent achieved a mean score of `-192.55`.
2. **Standard PPO:** Initial training yielded safe hovering behavior but failed to land effectively (local optimum).
3. **Reward Shaping:** Implemented a custom Gym `Wrapper` to intercept the environment's reward signal, actively penalizing horizontal drift (`abs(x) * 0.1`) and orientation tilt (`abs(angle) * 0.5`).
4. **Convergence:** The model was trained for 1,000,000 timesteps, resulting in consistent, soft landings between the target flags with a mean evaluation score exceeding 200.

## Reproducibility
To run this project locally:

```bash
# 1. Clone the repository and setup the environment
git clone <your-repo-url>
cd AI-Rocket-Sim
python -m venv venv
.\venv\Scripts\Activate.ps1

# 2. Install dependencies
pip install -r requirements.txt

# 3. Evaluate the fully trained model (outputs MP4 to /videos)
python evaluate_model.py