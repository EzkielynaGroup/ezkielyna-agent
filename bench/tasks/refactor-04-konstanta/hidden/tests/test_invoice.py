import unittest

import constants
from harga import harga_dengan_ppn
from invoice import ringkas, total_invoice
from ongkir import ongkir


class InvoiceTest(unittest.TestCase):
    def test_values(self):
        self.assertEqual(harga_dengan_ppn(100000), 111000)
        self.assertEqual(ongkir(1), 15000)
        self.assertEqual(ongkir(3), 25000)
        self.assertEqual(total_invoice([("a", 50000), ("b", 25000)], 2)["total"], 83250 + 20000)
        self.assertEqual(ringkas([1, 2]), "2 barang, PPN 11%, ongkir mulai 15000")

    def test_constants(self):
        self.assertEqual(constants.PPN, 0.11)
        self.assertEqual(constants.ONGKIR_DASAR, 15000)
