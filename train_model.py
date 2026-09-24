"""Train MOVA's small crowd-risk model from representative event scenarios."""
import json
import math
from pathlib import Path

# [density, movement_mps, arrival_pressure, exit_flow]
SCENARIOS = [
    ([1.0, 1.2, 0.8, 1.1], 0), ([1.6, 0.9, 1.0, 1.0], 0), ([2.1, 0.8, 1.1, 0.9], 0),
    ([2.4, 0.7, 1.2, 0.8], 1), ([2.7, 0.65, 1.3, 0.75], 1), ([3.0, 0.58, 1.5, 0.65], 1),
    ([3.3, 0.52, 1.7, 0.55], 2), ([3.7, 0.45, 1.9, 0.45], 2), ([4.2, 0.35, 2.2, 0.35], 2),
]


def scale(row):
    return [(row[0] / 4.5), (1 - row[1] / 1.3), (row[2] / 2.4), (1 - row[3] / 1.2)]


def softmax(values):
    top = max(values)
    exps = [math.exp(value - top) for value in values]
    total = sum(exps)
    return [value / total for value in exps]


def train():
    features = [scale(row) for row, _ in SCENARIOS]
    labels = [label for _, label in SCENARIOS]
    weights = [[0.0] * 4 for _ in range(3)]
    bias = [0.0] * 3
    learning_rate = 0.8
    for _ in range(1600):
        for row, label in zip(features, labels):
            logits = [sum(w * x for w, x in zip(class_weights, row)) + class_bias for class_weights, class_bias in zip(weights, bias)]
            probabilities = softmax(logits)
            for class_index in range(3):
                error = probabilities[class_index] - (1 if class_index == label else 0)
                for feature_index, value in enumerate(row):
                    weights[class_index][feature_index] -= learning_rate * error * value / len(features)
                bias[class_index] -= learning_rate * error / len(features)
    model = {
        'name': 'MOVA Crowd Risk Model',
        'version': '1.0.0',
        'classes': ['safe', 'watch', 'critical'],
        'features': ['density', 'slow_movement', 'arrival_pressure', 'low_exit_flow'],
        'weights': weights,
        'bias': bias,
        'normalization': {'density_max': 4.5, 'movement_max': 1.3, 'arrival_max': 2.4, 'exit_max': 1.2},
    }
    Path('model.json').write_text(json.dumps(model, indent=2) + '\n')
    print('Trained MOVA Crowd Risk Model -> model.json')


if __name__ == '__main__':
    train()
