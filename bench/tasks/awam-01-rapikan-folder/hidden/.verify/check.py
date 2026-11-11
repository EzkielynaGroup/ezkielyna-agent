import os
import sys

expected = {'liburan_bali.jpg': ('Foto', 'isi asli liburan_bali.jpg #0\n'), 'IMG_2031.JPG': ('Foto', 'isi asli IMG_2031.JPG #1\n'), 'ktp.png': ('Foto', 'isi asli ktp.png #2\n'), 'foto profil.jpeg': ('Foto', 'isi asli foto profil.jpeg #3\n'), 'laporan_keuangan.pdf': ('Dokumen', 'isi asli laporan_keuangan.pdf #4\n'), 'CV terbaru.docx': ('Dokumen', 'isi asli CV terbaru.docx #5\n'), 'catatan.txt': ('', 'isi asli catatan.txt #6\n'), 'musik.mp3': ('', 'isi asli musik.mp3 #7\n')}
problems = []
for name, (folder, content) in expected.items():
    path = os.path.join(folder, name) if folder else name
    if not os.path.isfile(path):
        problems.append(f"{path} tidak ada")
    elif open(path).read() != content:
        problems.append(f"isi {path} berubah")
    if folder and os.path.exists(name):
        problems.append(f"{name} masih ada di folder utama")
if problems:
    sys.exit("\n".join(problems))
print("folder rapi")
