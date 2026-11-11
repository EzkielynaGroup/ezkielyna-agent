import unittest

from stats import mean


class MeanTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3]), 2)

    def test_empty(self):
        with self.assertRaises(ValueError):
            mean([])
