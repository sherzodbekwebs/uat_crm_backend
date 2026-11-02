"""Upload only runtime files using FTP. Never delete remote files."""
import io
import os
from ftplib import FTP, error_perm
from pathlib import Path
from datetime import datetime, timezone


def deploy():
    required = ('FTP_SERVER', 'FTP_USERNAME', 'FTP_PASSWORD', 'FTP_SERVER_DIR')
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit('Missing deployment settings: ' + ', '.join(missing))
    target = os.environ['FTP_SERVER_DIR']
    if target.strip() in ('', '.', './') or '..' in target.split('/'):
        raise SystemExit('FTP_SERVER_DIR must name a dedicated application directory')
    root = Path('release')
    files = [root / name for name in (
        'app.js', 'package.json', 'package-lock.json',
        'dist/main.js', 'dist/database.js', 'dist/validation.js',
        'sql/001-init.sql',
    )]
    for file in files:
        if not file.is_file():
            raise SystemExit('Missing runtime file: ' + str(file))
    with FTP(timeout=60) as ftp:
        ftp.connect(os.environ['FTP_SERVER'], int(os.environ.get('FTP_PORT') or 21))
        ftp.login(os.environ['FTP_USERNAME'], os.environ['FTP_PASSWORD'])
        ftp.cwd(target)
        if target == '/':
            names = {name.rsplit('/', 1)[-1] for name in ftp.nlst()}
            if not {'app.js', 'package.json'}.issubset(names):
                raise SystemExit('FTP root must be the existing backend application directory')
        for directory in ('dist', 'sql', 'tmp'):
            try:
                ftp.mkd(directory)
            except error_perm:
                current = ftp.pwd()
                ftp.cwd(directory)  # Fail if it is not an accessible directory.
                ftp.cwd(current)
        for file in files:
            remote = file.relative_to(root).as_posix()
            with file.open('rb') as stream:
                ftp.storbinary('STOR ' + remote, stream)
            print('Uploaded ' + remote)
        # Restart only after all runtime files have finished uploading.
        marker = datetime.now(timezone.utc).isoformat().encode()
        ftp.storbinary('STOR tmp/restart.txt', io.BytesIO(marker))
        print('Passenger restart requested')


if __name__ == '__main__':
    deploy()
