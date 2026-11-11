cat >> stats.py <<'EOF'


def median(values):
    if not values:
        raise ValueError("median() of empty list")
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def mode(values):
    if not values:
        raise ValueError("mode() of empty list")
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    best = max(counts.values())
    return min(value for value, count in counts.items() if count == best)
EOF
cat > tests/test_median_mode.py <<'EOF'
import unittest

from stats import median, mode


class MedianModeTest(unittest.TestCase):
    def test_median(self):
        self.assertEqual(median([1, 3, 2]), 2)

    def test_mode(self):
        self.assertEqual(mode([2, 2, 1]), 2)
EOF
