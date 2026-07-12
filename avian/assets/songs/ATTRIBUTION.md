# Song clip attribution

**GENERATED FILE — do not edit by hand.** Built from the per-species `attr` blocks in
`avian/assets/signatures.json` (written by `avian/scripts/build-signatures.mjs`; signature
set generated 2026-07-06T16:23:47.126Z). The 53 mp3s in this directory are reference song
recordings from [xeno-canto](https://xeno-canto.org), bundled as the tap-to-play audio for
the song-signature blooms. Each recording keeps its own Creative Commons license (listed
per row) — credit the recordist. The repo as a whole is CC-BY-NC-SA-4.0 (non-commercial).

Regenerate from the repo root (re-extracts and reruns the script embedded below):

```sh
python3 -c "import re;p=chr(126)*3;exec(re.search(p+'python\n(.*?)'+p,open('avian/assets/songs/ATTRIBUTION.md').read(),re.S).group(1))" > avian/assets/songs/ATTRIBUTION.md.new && mv avian/assets/songs/ATTRIBUTION.md.new avian/assets/songs/ATTRIBUTION.md
```

~~~python
import json, re
F = '~' * 3
doc = open('avian/assets/songs/ATTRIBUTION.md', encoding='utf-8').read()
script = re.search(F + 'python\n(.*?)' + F, doc, re.S).group(1)
d = json.load(open('avian/assets/signatures.json', encoding='utf-8'))
sp = d['species']
def lic(u):
    p = [x for x in u.rstrip('/').split('/') if x]
    return 'CC ' + p[-2].upper() + ' ' + p[-1]
CMD = ('python3 -c "import re;p=chr(126)*3;exec(re.search(p+\'python\\n(.*?)\'+p,'
       'open(\'avian/assets/songs/ATTRIBUTION.md\').read(),re.S).group(1))"'
       ' > avian/assets/songs/ATTRIBUTION.md.new'
       ' && mv avian/assets/songs/ATTRIBUTION.md.new avian/assets/songs/ATTRIBUTION.md')
esc = lambda s: str(s).replace('|', '\\|')
out = []
out.append('# Song clip attribution\n')
out.append('**GENERATED FILE — do not edit by hand.** Built from the per-species `attr` blocks in')
out.append('`avian/assets/signatures.json` (written by `avian/scripts/build-signatures.mjs`; signature')
out.append(f"set generated {d['generated']}). The {len(sp)} mp3s in this directory are reference song")
out.append('recordings from [xeno-canto](https://xeno-canto.org), bundled as the tap-to-play audio for')
out.append('the song-signature blooms. Each recording keeps its own Creative Commons license (listed')
out.append('per row) — credit the recordist. The repo as a whole is CC-BY-NC-SA-4.0 (non-commercial).\n')
out.append('Regenerate from the repo root (re-extracts and reruns the script embedded below):\n')
out.append('```sh\n' + CMD + '\n```\n')
out.append(F + 'python\n' + script + F + '\n')
out.append('| Species | File | Recordist | License | Source |')
out.append('|---|---|---|---|---|')
for sci, v in sorted(sp.items()):
    a = v['attr']
    out.append(f"| *{esc(sci)}* | `{v['clip'].split('/')[-1]}` | {esc(a['rec'])} | [{lic(a['lic'])}]({a['lic']}) | [XC{a['id']}]({a['url']}) |")
print('\n'.join(out))
~~~

| Species | File | Recordist | License | Source |
|---|---|---|---|---|
| *Actitis macularius* | `actitis-macularius.mp3` | Don Profota | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1136683](https://xeno-canto.org/1136683) |
| *Agelaius phoeniceus* | `agelaius-phoeniceus.mp3` | Ron Overholtz | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC713846](https://xeno-canto.org/713846) |
| *Baeolophus bicolor* | `baeolophus-bicolor.mp3` | Antonio Xeira | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC310835](https://xeno-canto.org/310835) |
| *Bombycilla cedrorum* | `bombycilla-cedrorum.mp3` | Jeffrey Mann | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC771668](https://xeno-canto.org/771668) |
| *Buteo jamaicensis* | `buteo-jamaicensis.mp3` | Manuel Grosselet | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1090861](https://xeno-canto.org/1090861) |
| *Buteo platypterus* | `buteo-platypterus.mp3` | Thomas Magarian | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC933598](https://xeno-canto.org/933598) |
| *Cardinalis cardinalis* | `cardinalis-cardinalis.mp3` | Rory Nefdt | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1133842](https://xeno-canto.org/1133842) |
| *Catharus fuscescens* | `catharus-fuscescens.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1012569](https://xeno-canto.org/1012569) |
| *Chaetura pelagica* | `chaetura-pelagica.mp3` | Thomas Ryder Payne | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC636190](https://xeno-canto.org/636190) |
| *Charadrius vociferus* | `charadrius-vociferus.mp3` | Rory Nefdt | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1146761](https://xeno-canto.org/1146761) |
| *Colaptes auratus* | `colaptes-auratus.mp3` | Ted Floyd | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC410727](https://xeno-canto.org/410727) |
| *Contopus virens* | `contopus-virens.mp3` | Russ Wigh | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC563444](https://xeno-canto.org/563444) |
| *Corvus corax* | `corvus-corax.mp3` | Marcin Urbański | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC791383](https://xeno-canto.org/791383) |
| *Cyanocitta cristata* | `cyanocitta-cristata.mp3` | Thomas Magarian | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC933595](https://xeno-canto.org/933595) |
| *Dryobates pubescens* | `dryobates-pubescens.mp3` | Jacob Saucier | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC500162](https://xeno-canto.org/500162) |
| *Dryocopus pileatus* | `dryocopus-pileatus.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1012561](https://xeno-canto.org/1012561) |
| *Dumetella carolinensis* | `dumetella-carolinensis.mp3` | Sunny | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC484144](https://xeno-canto.org/484144) |
| *Geothlypis trichas* | `geothlypis-trichas.mp3` | Jeff Stewart | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1135839](https://xeno-canto.org/1135839) |
| *Haemorhous mexicanus* | `haemorhous-mexicanus.mp3` | Leonardo Guzman Hernandez | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC917973](https://xeno-canto.org/917973) |
| *Hirundo rustica* | `hirundo-rustica.mp3` | Susanne Kuijpers | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC662354](https://xeno-canto.org/662354) |
| *Hylocichla mustelina* | `hylocichla-mustelina.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1013065](https://xeno-canto.org/1013065) |
| *Junco hyemalis* | `junco-hyemalis.mp3` | Doug Hynes | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [XC569535](https://xeno-canto.org/569535) |
| *Melanerpes carolinus* | `melanerpes-carolinus.mp3` | Mario Reyes Jr | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1093541](https://xeno-canto.org/1093541) |
| *Meleagris gallopavo* | `meleagris-gallopavo.mp3` | Francesco Sottile | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC702183](https://xeno-canto.org/702183) |
| *Melospiza georgiana* | `melospiza-georgiana.mp3` | Doug Hynes | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [XC613096](https://xeno-canto.org/613096) |
| *Melospiza melodia* | `melospiza-melodia.mp3` | Rory Nefdt | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1142132](https://xeno-canto.org/1142132) |
| *Molothrus ater* | `molothrus-ater.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1012893](https://xeno-canto.org/1012893) |
| *Myiarchus crinitus* | `myiarchus-crinitus.mp3` | Kent Livezey | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC357427](https://xeno-canto.org/357427) |
| *Pandion haliaetus* | `pandion-haliaetus.mp3` | Manuel Grosselet | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC573484](https://xeno-canto.org/573484) |
| *Passer domesticus* | `passer-domesticus.mp3` | Pascal Christe | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [XC1148123](https://xeno-canto.org/1148123) |
| *Passerculus sandwichensis* | `passerculus-sandwichensis.mp3` | Isain Contreras Rodríguez | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC534764](https://xeno-canto.org/534764) |
| *Passerina cyanea* | `passerina-cyanea.mp3` | Pat Goltz | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1148218](https://xeno-canto.org/1148218) |
| *Pheucticus ludovicianus* | `pheucticus-ludovicianus.mp3` | David Darrell-Lambert | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1081957](https://xeno-canto.org/1081957) |
| *Poecile atricapillus* | `poecile-atricapillus.mp3` | Don Profota | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC866009](https://xeno-canto.org/866009) |
| *Polioptila caerulea* | `polioptila-caerulea.mp3` | Patrick Turgeon | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC253947](https://xeno-canto.org/253947) |
| *Progne subis* | `progne-subis.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1012823](https://xeno-canto.org/1012823) |
| *Quiscalus quiscula* | `quiscalus-quiscula.mp3` | Paul Driver | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC786565](https://xeno-canto.org/786565) |
| *Regulus satrapa* | `regulus-satrapa.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1013319](https://xeno-canto.org/1013319) |
| *Sayornis phoebe* | `sayornis-phoebe.mp3` | Brian Hendrix | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC562448](https://xeno-canto.org/562448) |
| *Seiurus aurocapilla* | `seiurus-aurocapilla.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1013786](https://xeno-canto.org/1013786) |
| *Setophaga pinus* | `setophaga-pinus.mp3` | Rory Nefdt | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1146755](https://xeno-canto.org/1146755) |
| *Sialia sialis* | `sialia-sialis.mp3` | Russ Wigh | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC570566](https://xeno-canto.org/570566) |
| *Sitta canadensis* | `sitta-canadensis.mp3` | Sunny Tseng | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC753160](https://xeno-canto.org/753160) |
| *Sitta carolinensis* | `sitta-carolinensis.mp3` | David Tattersley | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1000259](https://xeno-canto.org/1000259) |
| *Spinus tristis* | `spinus-tristis.mp3` | Romeo St-Cyr | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1040648](https://xeno-canto.org/1040648) |
| *Spizella passerina* | `spizella-passerina.mp3` | David Darrell-Lambert | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1081943](https://xeno-canto.org/1081943) |
| *Thryothorus ludovicianus* | `thryothorus-ludovicianus.mp3` | Sue Riffe | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC941065](https://xeno-canto.org/941065) |
| *Troglodytes aedon* | `troglodytes-aedon.mp3` | Homero Bennet | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1048918](https://xeno-canto.org/1048918) |
| *Turdus migratorius* | `turdus-migratorius.mp3` | Rory Nefdt | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC999808](https://xeno-canto.org/999808) |
| *Tyrannus tyrannus* | `tyrannus-tyrannus.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1014873](https://xeno-canto.org/1014873) |
| *Vireo olivaceus* | `vireo-olivaceus.mp3` | Mario Reyes Jr | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1107432](https://xeno-canto.org/1107432) |
| *Zenaida macroura* | `zenaida-macroura.mp3` | Paul Marvin | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) | [XC153654](https://xeno-canto.org/153654) |
| *Zonotrichia albicollis* | `zonotrichia-albicollis.mp3` | Stanislas Wroza | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | [XC1013211](https://xeno-canto.org/1013211) |
