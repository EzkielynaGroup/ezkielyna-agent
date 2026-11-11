import unittest

from stats import median, mode


class HiddenTest(unittest.TestCase):
    def test_median(self):
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([4, 1, 3, 2]), 2.5)

    def test_mode(self):
        self.assertEqual(mode([1, 2, 2, 3]), 2)
        self.assertEqual(mode([5, 1, 5, 1, 9]), 1)

    def test_empty(self):
        for fn in (median, mode):
            with self.assertRaises(ValueError):
                fn([])

    def test_input_not_mutated(self):
        values = [3, 1, 2]
        median(values)
        self.assertEqual(values, [3, 1, 2])
