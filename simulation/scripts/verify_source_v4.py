"""Recheck exact supplied source archives against an already retrieved public Git tree.
Usage: python3 scripts/verify_source_v4.py --tree /path/tree.json --archives /path/dispatch_sources
No optimization, downloads, or source data mutation occurs here.
"""
import argparse, hashlib, json, pathlib, zipfile

def sha256(data): return hashlib.sha256(data).hexdigest()
def git_blob(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--tree',required=True);parser.add_argument('--archives',required=True);args=parser.parse_args()
    root=pathlib.Path(__file__).resolve().parents[1];archives=pathlib.Path(args.archives)
    retrieved=json.loads(pathlib.Path(args.tree).read_text());tree={x['path']:x for x in retrieved['tree']}
    manifest=json.loads((root/'data/manifest.json').read_text());archive_checks=[]
    code='05_시뮬레이션코드/김민상_강내면_온라인DRT_주차3분_코드.zip'
    for path,local in [(code,archives/'code.zip')]+[(r['repositoryPath'],archives/(r['date']+'.zip')) for r in manifest['provenance']['resultArchives']]:
        data=local.read_bytes();entry=tree[path];actual=git_blob(data)
        assert actual==entry['sha'] and len(data)==entry['size'],path
        archive_checks.append(dict(path=path,bytes=len(data),gitBlobSha=actual,sha256=sha256(data),matched=True))
    spatial=[]
    for entry in manifest['provenance']['sources']:
        current=tree[entry['repositoryPath']];assert current['sha']==entry['gitBlobSha'],entry['name']
        spatial.append(dict(path=entry['repositoryPath'],gitBlobSha=current['sha'],matchedExistingProvenance=True))
    snapshots=calls=0;checks=[]
    for run in manifest['runs']:
        day=run['date'];scenario=run['scenario']+('_passenger_only' if run['mode']=='passenger_only' else '')
        decision=json.loads((root/'data/decisions'/ (run['id']+'.json')).read_text());p=decision['provenance']
        with zipfile.ZipFile(archives/(day+'.zip')) as z:
            names=z.namelist()
            for filename,key in [('plans.jsonl','plansSha256'),('decisions.csv','decisionsSha256')]:
                candidates=[n for n in names if n.endswith('/'+day+'/'+scenario+'/'+filename)]
                assert len(candidates)==1,(run['id'],filename,candidates)
                assert sha256(z.read(candidates[0]))==p[key],(run['id'],filename)
        assert sha256((root/run['url']).read_bytes())==p['canonicalRunSha256'],run['id']
        assert p['repositoryCommit']==retrieved['commit'] and p['codeGitBlob']==tree[code]['sha']
        snapshots+=len(decision['snapshots']);calls+=len(decision['calls']);checks.append(dict(runId=run['id'],matchedOriginalPlans=True,matchedOriginalDecisions=True,matchedCanonicalReplay=True))
    out=dict(schemaVersion=1,checkedOn='2026-11-25',source='GitHub plugin public repository tree + local Git blob hashes + ZIP member SHA256',repository='https://github.com/km-minsang/MetroRookies',sourceCommit=retrieved['commit'],archives=archive_checks,spatialProvenance=spatial,runChecks=checks,runCount=len(checks),planSnapshots=snapshots,passengerDecisions=calls,passed=True)
    path=root/'docs/source-verification-v4.json';path.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:out[k] for k in ['sourceCommit','runCount','planSnapshots','passengerDecisions','passed']}))
if __name__=='__main__':main()
