"""Google Sheets / Drive / Forms client for the REM UF recruitment tools.

Auth (first match wins):
  1. Service account JSON at GOOGLE_APPLICATION_CREDENTIALS or secrets/service-account.json
  2. OAuth desktop client at secrets/client_secret.json (token cached as secrets/token.json)

Never print credential material. Share the three sheets (and the Drive folder, for
discovery) with the service-account email — Viewer for pull, Editor for push.
"""
import os

SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/forms.body.readonly',
]

SECRETS_DIR = 'secrets'
SERVICE_ACCOUNT_FILE = os.path.join(SECRETS_DIR, 'service-account.json')
CLIENT_SECRET_FILE = os.path.join(SECRETS_DIR, 'client_secret.json')
TOKEN_FILE = os.path.join(SECRETS_DIR, 'token.json')


def _service_account_path():
    env = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if env and os.path.exists(env):
        return env
    if os.path.exists(SERVICE_ACCOUNT_FILE):
        return SERVICE_ACCOUNT_FILE
    return None


def get_creds():
    sa = _service_account_path()
    if sa:
        from google.oauth2 import service_account
        return service_account.Credentials.from_service_account_file(sa, scopes=SCOPES)

    if not os.path.exists(CLIENT_SECRET_FILE):
        raise SystemExit(
            'No Google credentials found.\n'
            '  Put a service account JSON at secrets/service-account.json\n'
            '  (or set GOOGLE_APPLICATION_CREDENTIALS), or an OAuth client at\n'
            '  secrets/client_secret.json. See README for Adam setup steps.'
        )

    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        os.makedirs(SECRETS_DIR, exist_ok=True)
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(creds.to_json())
    if not creds or not creds.valid:
        flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET_FILE, SCOPES)
        creds = flow.run_local_server(port=0)
        os.makedirs(SECRETS_DIR, exist_ok=True)
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(creds.to_json())
    return creds


def sheets_service():
    from googleapiclient.discovery import build
    return build('sheets', 'v4', credentials=get_creds(), cache_discovery=False)


def drive_service():
    from googleapiclient.discovery import build
    return build('drive', 'v3', credentials=get_creds(), cache_discovery=False)


def forms_service():
    from googleapiclient.discovery import build
    return build('forms', 'v1', credentials=get_creds(), cache_discovery=False)


def read_values(spreadsheet_id, range_a1):
    svc = sheets_service()
    res = svc.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=range_a1,
    ).execute()
    return res.get('values') or []


def write_values(spreadsheet_id, range_a1, values):
    svc = sheets_service()
    return svc.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=range_a1,
        valueInputOption='RAW',
        body={'values': values},
    ).execute()


def clear_values(spreadsheet_id, range_a1):
    svc = sheets_service()
    return svc.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id, range=range_a1,
    ).execute()


def spreadsheet_meta(spreadsheet_id):
    svc = sheets_service()
    return svc.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields='properties.title,sheets.properties',
    ).execute()


def ensure_tab(spreadsheet_id, title):
    meta = spreadsheet_meta(spreadsheet_id)
    for sh in meta.get('sheets') or []:
        props = sh.get('properties') or {}
        if props.get('title') == title:
            return props.get('sheetId')
    svc = sheets_service()
    res = svc.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={'requests': [{'addSheet': {'properties': {'title': title}}}]},
    ).execute()
    return res['replies'][0]['addSheet']['properties']['sheetId']


def search_files(query, page_size=20):
    svc = drive_service()
    res = svc.files().list(
        q=query,
        pageSize=page_size,
        fields='files(id,name,mimeType,parents)',
        includeItemsFromAllDrives=True,
        supportsAllDrives=True,
    ).execute()
    return res.get('files') or []


def resolve_form_response_sheet(form_id):
    """Forms API linkedSheetId, or Drive search for '{form title} (Responses)'."""
    try:
        form = forms_service().forms().get(formId=form_id).execute()
        linked = form.get('linkedSheetId')
        if linked:
            return linked, form.get('info', {}).get('title') or ''
        title = (form.get('info') or {}).get('title') or ''
        if title:
            hits = search_files(
                f"name = '{title} (Responses)' and mimeType = 'application/vnd.google-apps.spreadsheet'"
            )
            if hits:
                return hits[0]['id'], hits[0]['name']
        return None, title
    except Exception:
        return None, ''


def find_info_session_sheet(title_hint='Rem Information Session Fall 2026'):
    queries = [
        f"name contains '{title_hint}' and mimeType = 'application/vnd.google-apps.spreadsheet'",
        "name contains 'Information Session' and name contains 'Responses' and mimeType = 'application/vnd.google-apps.spreadsheet'",
        "name contains 'Info Session' and name contains 'Responses' and mimeType = 'application/vnd.google-apps.spreadsheet'",
    ]
    for q in queries:
        hits = search_files(q)
        if hits:
            return hits[0]['id'], hits[0]['name']
    return None, None
