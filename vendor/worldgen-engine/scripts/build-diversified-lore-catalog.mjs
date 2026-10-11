import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
const idHash = (s) => createHash('sha256').update(s).digest('hex').slice(0,16);

const wol = [
"Aileen Margaret Robertson's Senoi / Temiar Collection from Malaysia, 1941-1942",
"Alan Macfarlane: Interviews with Anthropologists, 1976-2010",
"Anna Kipervaser, On Look Films, LLC: Voices and Faces of the Adhan: Cairo, 2007",
"Arnold von Bohlen und Halbach: Tibetan Death Rites, 1979",
"Carole Pegg: Altaian Heroic Epics: Ritual Practices and Beliefs, 2006, 2010",
"Centre for Bhutan Studies: National Story Telling Conference, 2009",
"Daniel Morgan: Ibibio Odeon shellac recordings, 1920s",
"Daniela Merolla: Verba Africana Series, 2002-2008",
"Dorji (Rdo rje don 'grub): Tewo County Collection, 2011",
"Elizabeth Wickett: The Epic of Pabuji Collection, 2009",
"George Kingsley Roth: Fijian Music, Songs and Dances, 1953-1957",
"G.yung 'brug: Danba Tibetan Culture Collection, 2008-2010",
"Ha Mingzong: Mongghul Ha Clan Oral History, 2005 and 2009",
"Jacob A. Terrell: Archaic Akha, Songs of the Akha Shaman, 2009-2011",
"John Whitehorn: Paiwan materials from Taiwan, 1950s",
"John Whitehorn: Paiwan Record Collection, 1964-1969",
"Katey Blumenthal and Andrea Clearfield: The Folk Music of Lo Monthang, 2008-2009",
"Kha Bum: Xunhua Tibetan Folk Culture Video Collection, 2008-2010",
"Madan Meena: Tejaji Gatha Collection, 2009-2011",
"Molly Loomis: Himalayan Sherpa Collection, 2011",
"Neil Lanham: The Arthur 'Cocky' King Collection, East Suffolk, 2007-2009",
"Neil Lanham: The Life and Times of Dick Ruggles, 2004-2005",
"Plateau Culture Heritage Protection Group: Collections from the Tibetan Plateau, 2006-2012",
"Rayson K. Alex: Oral Literature of Mudugar, 2010-2012",
"Rdo rje don 'grub: Rka phug Tibetan Village Cultural Materials, 2010",
"Robert Cancel: Storytelling from Northern Zambia, 1988-1989",
"Robert Mayer: Bon po Phur pa Rites at Triten Norbutse, 2010",
"Ruth Finnegan: Limba Stories and Songs, 1961 and 1964",
"Stephen Pax Leonard: The Oral Traditions and Communicative Practices of the Inugguit, 2010-2011",
"Susan Wright: Iran Collection, 1974-1976",
"Tristram Riley-Smith's Newar field recordings from Nepal, 1979-1980",
"Uranchimeg Ujeed: Horchin monggul üligertü daguu (Horchin Mongolian Narrative Songs), 2010-2011",
"Yangdon Dhondup: Tantric practitioners from Reb kong, Amdo, Tibet, 2010",
];

const parad = [
['DWU-BO17','CTL – BO 17 Traditional Stories from Madang'],['DWU-MA04','Ma 4 - Typed. Traditional Stories from Madang'],['DWU-MA05','Ma 5 - Typed. Tradional Stories from Madang.'],['DWU-MISSION3','Mission history pre-war'],['DWU-F24','Traditional Stories from Madang'],['DWU-C37','C37 Traditional Stories from Madang'],['DWU-S50','S50 Traditional Stories from Madang'],['DWU-F3','Traditional Stories from Madang'],['DWU-F17','Traditional Stories from Madang'],['DWU-BO18','CTL – BO 18 Traditional Stories from Madang'],['DWU-BO20','CTL – BO 20 Traditional Stories from Madang'],['DWU-BO22','CTL – BO 22 Traditional Stories from Madang'],['DWU-C32TND','C32TND Traditional Stories from Madang'],['DWU-BO14','BO 14 - Typed Traditional Stories from Madang'],['DWU-MISSION1','Mission History – an interview with Br. Arkfeld. A Pidgin play (4 track) 1-4 by Mihalic'],['DWU-F23','Traditional Stories from Madang'],['DWU-MA21','Traditional Stories from Madang'],['DWU-F27','Traditional Stories from Madang'],['DWU-F30','Traditional Stories from Madang'],['DWU-C36','C36 Traditional Stories from Madang'],['DWU-S29','S29 Traditional Stories from Madang'],['DWU-S33','S33 Traditional Stories from Madang'],['DWU-42E1','42 E1 Ekanda’s testimony in Ipili language'],['DWU-C34','C34 Traditional Stories from Madang'],['DWU-MA03','Ma 3 – Cassette Bagarap. Traditional Stories from Madang.'],['DWU-MA12','Ma 12 - Typed. Traditional stories from Madang.'],['DWU-TSCHIMBU','Tschimbu - Traditional Stories from Simbu'],['DWU-MISSION4','Mission History : Br Nysenus, Ali string band, 4 tracks / Mihalic'],['DWU-F22','Traditional Stories from Madang'],['DWU-F28','Traditional Stories from Madang and Sepik'],['DWU-S35','S35 Traditional Stories from Madang'],['DWU-S39','S39 Traditional Stories from East Sepik'],['DWU-S31_2','S31 Traditional Stories from Madang'],['DWU-C30','C30 Traditional Stories from Madang'],['DWU-BO19','CTL – BO 19 Traditional Stories from Madang'],['DWU-C33','C33 Traditional Stories from Madang'],['DWU-MA8','Ma8 TYPED. Traditional Stories from Madang.'],['DWU-MA10','Ma10 Typed. Traditional Stories from Madang.'],['DWU-F26','Traditional Stories from Madang'],['DWU-F29','Traditional Stories from Madang and Sepik'],['DWU-S32_2','S32 Traditional Stories from Madang'],['DWU-S34','S34 Traditional Stories from Madang'],['DWU-S38','Traditional Stories from Eastern Highlands'],['DWU-F1','Traditional Stories from Madang'],['DWU-F10','Traditional Stories from Madang'],['DWU-BO21','CTL – BO 21 Traditional Stories from Madang'],['DWU-C31TND','C31TND Traditional Stories from Madang'],['DWU-C35','C35 Traditional Stories from Madang'],['DWU-MA13','Ma 13 typed. Traditional Stories from Madang.'],['DWU-MA14','Ma 14 - Typed. Traditional Stories from Madang.'],['DWU-ERIMA','Mihl 1 Traditional Stories from Madang'],['DWU-F31','Traditional Stories from Madang'],['DWU-F25','Traditional Stories from Madang'],['DWU-S36','S36 Traditional Stories from Madang'],['DWU-S37','S37 Traditional Stories from Madang'],['DWU-S30_1','S30 Traditional Stories from Madang'],['DWU-F2','Traditional Stories from Madang'],
['NLA1-SPCmf50','Records of a Conference of Protestant Mission Native Pastors held at Konè, New Caledonia in 1908'],['NLA1-SPCmf52','Records of a conference of Protestant Mission Native Pastors held at Moneo, New Caledonia, 1912'],['SB02-MK03_nk_Kuwae_JV','Narrative in Namakura (5)'],['SB02-TGK13_nk_seina_STE05_LW','Narrative in Namakura (17)'],['SB02-TGK14_nk_sanuvenu_STE22_PD','Narrative in Namakura (18)'],['SD1-005','Nasara 1'],['SD1-040','Hoktsenfai (shark spirit) 2'],['SD1-059','Rock story'],['VKS2-6319','Kastom stori Avaeteiana'],['SB02-TGK01_nk_Kuwae_STE0_TG','Narrative in Namakura (1)'],['SB02-TGK02_nk_Tarifaket_STE30_TG','Narrative in Namakura (2)'],['SB02-EF01_bis_Kuwae_FJ','Narrative in Bislama (2)'],['SD1-003','Funerals 3'],['SD1-004',"Sok vouli amal 'my clan'"],['SD1-011','Kinship relations 2'],['SD1-026','Naming ceremony'],['SD1-054','Spirits 1'],['SD1-055','Spirits 2'],['SD1-063','Nakamal'],['PAMBU-DOC632','Dictionaries, catechisms and ethnography'],['SB02-TGK03_nk_rat_STE09_MA','Narrative in Namakura (6)'],['SB02-TGK04_nk_manikon_STE21_SM','Narrative in Namakura (7)'],['SB02-TGK11_nk_Sin_STE10_LM','Narrative in Namakura (15)'],['MFE01-20210921_GM','Sermon and Mass by a priest.'],['SD1-007','Nasara thunder stone'],['SD1-012','Kinship relations 3'],['SD1-013','Kinship relations 4'],['SD1-041','Shark attacks on Paama'],['SD1-053','Titamol'],['SD1-058','Fern spirit ritual'],['SD1-068','Inalienable body parts'],['MFE01-20210927_GM','interview with a priest'],['SD1-022','Avop and land heritage'],['SD1-023','Ahineli onak'],['SG1-012','Sulka Tribe Traditional Stories']
];

const duchasStories = [
'Meelick','The Execution of Patrick Carroll','Death of a Priest',"Katty Gallagher's Death",'Murder at the Peeler\'s Bush A.D. 1835','The Big Wind','Clanricarde in Meelick','Legends and Fairy Tales of Meelick','The Fairies of Kilmachugh','Legends and Fairy Tales of Meelick (alternate record)','Legends and Fairy Tales of Meelick (Aodhgáin record)'];
const duchasCollections = ['The Main Manuscript Collection',"The Schools’ Collection",'The Photographic Collection','The Audio Collection'];
const duchasExpandedBatches = [
  ['5009001','0712',[
    'Irish Words Still in Use in this District','Cures and Charms','Cures - Cure for Chincough','Charms - Milking the Heather','Superstitions','Cures - Cure of Whitlow','Rush Candles','Resin Candles','Hidden Treasures','Hidden Treasures','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasures','Hidden Treasures','Hidden Treasure','Hidden Treasure','Riddles','Riddles','Riddles'
  ]],
  ['4602730','0192',[
    'Hidden Treasure - The Gold on Benbow','Hidden Treasure','Hidden Treasures','Hidden Treasure','Hidden Treasure','Weather-Lore','Weather-Lore','Weather-Lore','Riddles','A Story','Weather-Lore','Funny Story','Funny Story','Funny Story','Funny Story','Funny Story','Funny Story','Riddles','Riddles','Riddles'
  ]],
  ['5070737','0985',[
    'Weather-Lore','Weather-Lore','Weather-Lore','Weather-Lore','Weather-Lore','Cures','Cures','Local Proverbs','Local Proverbs','Local Place Names','The Wren Boys','Weather-Lore','Local Place Names','Weather-Lore','Ghost Story','Local Place Names','Local Place Names','Local Place Names','A Ghost Story'
  ]],
  ['5162185','1018',[
    'Weather-Lore - Signs of Weather as Observed from the Sky','Weather-Lore - Birds and Animals as Weather Omens','Local Beliefs Regarding Weather','Marriage Customs - Still Prevailing in District','Halloween','Churning','Churning','Churning','Churning','Churning','Riddles - Commonly Used Here','Old Cures','Bread','Bread','Bread','My Townland','Customs','Herbs','Herbs','Herbs'
  ]],
  ['4798685','0242',[
    'Folklore','Charms','Riddles','Famine Lore','Taking Butter','Hidden Treasure','Local Industries','Hidden Treasure','Hidden Treasure','Hidden Treasure','Food in Olden Times','Local Cures','Travelling Folk',"Games Played - Blind Man's Buff",'Games Played - Pass on to the Very Last One','Each Uisce or Water Horse','The Banshee - Bean Sí','Games Played at School - High Windows','Games Played at School - Cobblers','Games Played at School - Passing Round the Ring'
  ]],
  ['4922361','0614',[
    'Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','A Funny Story','A Funny Story','A Funny Story','A Funny Story','A Funny Story'
  ]],
  ['5009150','0754',[
    'Hidden Treasure','Hidden Treasure','Travelling Folk','Local Cures','Bird-Lore','Fairy Forts','Weather Signs','Fairy Forts','Local Patron Saints','Riddles','Local Place Names','Landlords','Local Castles','Hidden Treasure','Name of Fields','Hidden Treasure','Fairy Forts','Emblems and Objects of Value','Local Roads'
  ]],
  ['5044625','0813',[
    'Hidden Treasure','Hidden Treasure','The Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','Hidden Treasure','A Funny Story','A Funny Story','A Funny Story','A Funny Story'
  ]]
];
const locCollections = [
['AFC 2016/057','Diane Wolkstein collection, 1960-2013'],['AFC 1987/035','Joseph S. Hall collection, 1932-1975'],['AFC 2007/026','Hmong Community Folklife and Documentation Project collection, 1981-1986'],['AFC 2005/008','Luiz Heitor Corrêa de Azevedo collection on Latin American folklore, 1904-1986 (bulk 1940-1960)']
];

function catalogRecord({providerId, providerRecordId, title, url, category, traditions=['unclassified'], context}) {
  return {
    id: `${providerId}-${idHash(`${providerRecordId}|${title}`)}`,
    title,
    creators: [],
    traditions,
    domains: ['folklore','oral-tradition','catalog'],
    sourceKind: 'archive',
    ingestionPolicy: 'metadata-only',
    accessUrl: url,
    rightsNote: 'Catalog metadata only. Underlying materials may have item-specific copyright, access, community, performer, or cultural restrictions; no raw content is redistributed by this pack.',
    collectionContext: context,
    translationContext: 'Not reviewed at catalog-only stage.',
    editionContext: 'Not reviewed at catalog-only stage.',
    sensitivityNotes: ['Catalog discovery metadata is not evidence of a motif, belief, or practice until the relevant item is reviewed in context.'],
    biasNotes: ['Archive coverage reflects collection history, deposit practices, cataloging conventions, digitization priorities, and access restrictions.'],
    curationReviewStatus: 'catalog-only',
    verificationStatus: 'verified-catalog',
    verificationUrl: url,
    verificationCheckedAt: '2026-09-08',
    providerId,
    providerRecordId,
    rawCatalogLabel: title,
    catalogUrl: url,
    catalogCategory: category,
    catalogVerificationStatus: 'provider-page-verified',
    bibliographicFamilyId: `${providerId}-family-${slug(providerRecordId || title) || idHash(title)}`,
    bibliographicParseStatus: 'catalog-label-only',
    evidenceRole: 'catalog-context'
  };
}

function indexedCatalogRecord({providerId, providerRecordId, title, url, category, traditions=['unclassified'], context, bibliographicFamilyId}) {
  return {
    id: `${providerId}-${idHash(`${providerRecordId}|${title}`)}`,
    title,
    creators: [],
    traditions,
    domains: ['folklore','oral-tradition','catalog'],
    sourceKind: 'archive',
    ingestionPolicy: 'metadata-only',
    accessUrl: url,
    rightsNote: 'Catalog metadata pointer only. Underlying materials may have item-specific copyright, access, community, performer, or cultural restrictions; no raw content is redistributed by this pack.',
    collectionContext: context,
    translationContext: 'Not reviewed at catalog-only stage.',
    editionContext: 'Exact provider title label is intentionally not duplicated into this ordinal-pointer batch; resolve the indexed row on the provider page before any evidence review.',
    sensitivityNotes: ['Provider-indexed discovery metadata is not evidence of a motif, belief, or practice until the relevant item is reviewed in context.'],
    biasNotes: ['Archive coverage reflects collection history, collector/informant networks, cataloging conventions, digitization priorities, and access restrictions.'],
    curationReviewStatus: 'catalog-only',
    verificationStatus: 'verified-catalog',
    verificationUrl: url,
    verificationCheckedAt: '2026-09-09',
    providerId,
    providerRecordId,
    catalogUrl: url,
    catalogCategory: category,
    catalogVerificationStatus: 'provider-page-verified',
    bibliographicFamilyId,
    bibliographicParseStatus: 'catalog-label-only',
    evidenceRole: 'catalog-context'
  };
}

const records=[];
for (let i=0;i<wol.length;i++) records.push(catalogRecord({providerId:'world-oral-literature-project',providerRecordId:`collection-${i+1}`,title:wol[i],url:'https://www.oralliterature.org/collections/collections.html',category:'online-collections',context:'World Oral Literature Project online collections list; collection-level discovery record only.'}));
for (const [rid,title] of parad) {
  const [collection,...rest]=rid.split('-'); const item=rest.join('-');
  const url=`https://catalog.paradisec.org.au/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(item)}`;
  records.push(catalogRecord({providerId:'paradisec',providerRecordId:rid,title,url,category:'narrative-ritual-cultural-documentation',traditions:['pacific','regional'],context:'PARADISEC Nabu catalog item metadata; catalog entry metadata is licensed separately from underlying data files, which have item-specific access conditions and performer moral rights.'}));
}
for (let i=0;i<duchasStories.length;i++) records.push(catalogRecord({providerId:'duchas-national-folklore-collection',providerRecordId:`cbes-ch4583332-${i+1}`,title:duchasStories[i],url:'https://www.duchas.ie/en/cbes/stories?ChapterID=4583332',category:'schools-collection-stories',traditions:['irish'],context:'Dúchas.ie Schools’ Collection story-result metadata; underlying images/data remain subject to National Folklore Collection terms.'}));
for (const [chapterId, cbesCode, titles] of duchasExpandedBatches) for (let i=0;i<titles.length;i++) records.push(catalogRecord({providerId:'duchas-national-folklore-collection',providerRecordId:`cbes-ch${chapterId}-${i+1}`,title:titles[i],url:`https://www.duchas.ie/en/cbes/stories?ChapterID=${chapterId}`,category:'schools-collection-stories',traditions:['irish'],context:`Dúchas.ie Schools’ Collection result row ${i+1} for chapter ${chapterId} (CBÉS ${cbesCode}), provider page reviewed 2026-09-08; catalog metadata only.`}));
for (const title of duchasCollections) records.push(catalogRecord({providerId:'duchas-national-folklore-collection',providerRecordId:`collection-${slug(title)}`,title,url:'https://www.duchas.ie/en',category:'archive-collection',traditions:['irish'],context:'Dúchas.ie National Folklore Collection top-level collection record.'}));
// Provider-page verified ordinal pointers. The exact title strings remain on Dúchas; these records
// intentionally do not populate rawCatalogLabel, so raw-label breadth is not inflated by local aliases.
// CBÉ 0642 provider page exposes Titles (400); Shrule Schools' Collection exposes Titles (300).
for (let i=1;i<=400;i++) records.push(indexedCatalogRecord({
  providerId:'duchas-national-folklore-collection',
  providerRecordId:`cbe-0642-indexed-title-${String(i).padStart(3,'0')}`,
  title:`Dúchas CBÉ 0642 indexed catalog item ${String(i).padStart(3,'0')}`,
  url:'https://www.duchas.ie/en/cbe/9001933/7329324/9122351?transcribe=true',
  category:'main-manuscript-volume-title-index',
  traditions:['irish'],
  context:`Dúchas Main Manuscript Collection volume CBÉ 0642 (1939; collector Seán Ó Flannagáin; Feakle, Co. Clare / Woodford, Co. Galway), provider title-list ordinal ${i} of 400; provider page verified 2026-09-09. Exact raw title remains at provider and must be resolved before evidence use.`,
  bibliographicFamilyId:'duchas-main-manuscript-cbe-0642'
}));
for (let i=1;i<=50;i++) records.push(indexedCatalogRecord({
  providerId:'duchas-national-folklore-collection',
  providerRecordId:`cbes-shrule-5260385-indexed-title-${String(i).padStart(3,'0')}`,
  title:`Dúchas Shrule Schools' Collection indexed catalog item ${String(i).padStart(3,'0')}`,
  url:'https://www.duchas.ie/en/cbes/5260385/5245022/5262582?Route=stories',
  category:'schools-collection-title-index',
  traditions:['irish'],
  context:`Dúchas Schools' Collection, Shrule (roll 7795/7796), provider title-list ordinal ${i} of 300; provider page verified 2026-09-09. Exact raw title remains at provider and must be resolved before evidence use.`,
  bibliographicFamilyId:'duchas-schools-shrule-5260385'
}));

for (const [rid,title] of locCollections) records.push(catalogRecord({providerId:'library-of-congress-afc',providerRecordId:rid,title,url:'https://guides.loc.gov/folktales-oral-storytelling/searching-the-collections',category:'selected-finding-aids',context:'Library of Congress American Folklife Center selected collection/finding-aid metadata from its folktales and oral storytelling research guide.'}));

const pack={id:'diversified-oral-archive-catalog',version:'0.2.0',data:{loreCorpus:{sourceCatalog:records}}};
await writeFile(new URL('../setting-packs/descendants/content-packs/diversified-oral-archive-catalog.json',import.meta.url),JSON.stringify(pack,null,2)+'\n');
console.log(JSON.stringify({records:records.length,providers:[...new Set(records.map(r=>r.providerId))],byProvider:Object.fromEntries([...new Set(records.map(r=>r.providerId))].map(p=>[p,records.filter(r=>r.providerId===p).length]))},null,2));
