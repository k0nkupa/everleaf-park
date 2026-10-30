"""Export Tony's scenes for the browser. Runs in background Blender; never saves source .blend files."""
import bpy, json, math, hashlib
from pathlib import Path
from mathutils import Vector
SOURCE=Path(globals().get('SOURCE','/Users/tony/Downloads/everleaf_blender'))
OUTPUT=Path(globals().get('OUTPUT',str(Path.cwd()/'public/models')))
KIND=globals().get('KIND','C_house')
OUTPUT.mkdir(parents=True,exist_ok=True)
bpy.context.preferences.filepaths.use_scripts_auto_execute=False
bpy.ops.wm.open_mainfile(filepath=str(SOURCE/(KIND+'.blend')),load_ui=False,use_scripts=False)
scene=bpy.context.scene
bpy.context.view_layer.update()
def xyz(v):return [round(v.x,4),round(v.z,4),round(-v.y,4)]
def bounds(o):
 pts=[o.matrix_world@Vector(c) for c in o.bound_box]
 return [min(p[i] for p in pts) for i in range(3)]+[max(p[i] for p in pts) for i in range(3)]
cam=scene.camera
forward=cam.matrix_world.to_quaternion()@Vector((0,0,-1))
distance=(1-cam.location.z)/forward.z if abs(forward.z)>.01 else 8
target=cam.location+forward*max(2,min(35,distance))
meta={'source':KIND+'.blend','sha256':hashlib.sha256((SOURCE/(KIND+'.blend')).read_bytes()).hexdigest(),'camera':{'position':xyz(cam.location),'target':xyz(target),'width':cam.data.ortho_scale if cam.data.type=='ORTHO' else 2*(cam.location-target).length*math.tan(cam.data.angle_x/2)},'colliders':[],'photos':[],'plots':[]}
if KIND=='village':
 roots=sorted([o for o in scene.objects if o.type=='EMPTY' and o.name.startswith('root')],key=lambda o:int(o.name.split('.')[-1]) if '.' in o.name else -1)
 meta['plots']=[xyz(o.matrix_world.translation) for o in roots]
for o in scene.objects:
 if o.type!='MESH':continue
 b=bounds(o);dx,dy,dz=[b[i+3]-b[i] for i in range(3)]
 solid_box=o.name.startswith('Cube') and b[2]<.8 and b[5]>.25 and max(dx,dy)>.7 and min(dx,dy)>.015 and max(dx,dy)<12
 solid_round=o.name.startswith('Cylinder') and b[2]<.8 and b[5]>.25 and .35<min(dx,dy) and max(dx,dy)<3
 if solid_box or solid_round:
  if KIND=='village' and solid_box and dz<1.3:continue
  meta['colliders'].append([round(b[0],3),round(-b[4],3),round(b[3],3),round(-b[1],3)])
# Flatten unsupported procedural color networks to their palette. Packed image materials stay intact.
for mat in bpy.data.materials:
 if not mat.use_nodes:continue
 nodes=mat.node_tree.nodes
 p=next((n for n in nodes if n.type=='BSDF_PRINCIPLED'),None)
 if not p:continue
 socket=p.inputs.get('Base Color')
 if socket and socket.is_linked and socket.links[0].from_node.type!='TEX_IMAGE':
  node=socket.links[0].from_node
  ramps=[n for n in nodes if n.type=='VALTORGB']
  if ramps:
   stops=list(ramps[-1].color_ramp.elements)
   c=[sum(e.color[i] for e in stops)/len(stops) for i in range(4)]
   for link in list(socket.links):mat.node_tree.links.remove(link)
   socket.default_value=c
# Keep photos and the sculpture replaceable; merge static geometry by material to reduce draw calls.
geometry=[];special=[]
for o in list(scene.objects):
 if o.hide_render:continue
 if o.type not in ['MESH','CURVE','META','FONT','SURFACE']:continue
 if KIND=='village' and o.type in ['META','FONT']:
  if o.type=='FONT' and o.name=='Text':geometry.append(o)
  continue
 if o.type=='META':
  o.name='pet_sculpture';special.append(o);meta['sculpture']={'position':xyz(o.matrix_world.translation),'bounds':bounds(o)};continue
 mats=list(o.data.materials) if hasattr(o.data,'materials') else []
 image=next((n.image for m in mats if m and m.use_nodes for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image),None)
 if image:
  o.name='photo_slot_'+str(len(meta['photos']));meta['photos'].append({'node':o.name,'position':xyz(o.matrix_world.translation)});special.append(o)
 else:geometry.append(o)
# Build merged evaluated meshes directly; repeated operator joins are too slow for this village.
depsgraph=bpy.context.evaluated_depsgraph_get()
groups={}
for original in geometry:
 evaluated=original.evaluated_get(depsgraph)
 mesh=evaluated.to_mesh(preserve_all_data_layers=False,depsgraph=depsgraph)
 if not mesh:continue
 mats=list(mesh.materials);key=tuple(m.name if m else '' for m in mats)
 group=groups.setdefault(key,{'vertices':[],'faces':[],'materials':mats,'indices':[],'smooth':[]})
 offset=len(group['vertices'])
 group['vertices'].extend([tuple(original.matrix_world@v.co) for v in mesh.vertices])
 group['faces'].extend([tuple(i+offset for i in p.vertices) for p in mesh.polygons])
 group['indices'].extend([p.material_index for p in mesh.polygons])
 group['smooth'].extend([p.use_smooth for p in mesh.polygons])
 evaluated.to_mesh_clear()
merged=[]
for index,group in enumerate(groups.values()):
 mesh=bpy.data.meshes.new('web_environment_'+str(index))
 mesh.from_pydata(group['vertices'],[],group['faces']);mesh.update()
 for mat in group['materials']:mesh.materials.append(mat)
 for p,i,smooth in zip(mesh.polygons,group['indices'],group['smooth']):p.material_index=i;p.use_smooth=smooth
 o=bpy.data.objects.new('environment_'+str(index),mesh);scene.collection.objects.link(o);merged.append(o)
for index,o in enumerate(special):
 if o.type=='META':
  mesh=bpy.data.meshes.new_from_object(o.evaluated_get(depsgraph),preserve_all_data_layers=True,depsgraph=depsgraph)
  o.name='source_pet';replacement=bpy.data.objects.new('pet_sculpture',mesh);replacement.matrix_world=o.matrix_world.copy();scene.collection.objects.link(replacement);special[index]=replacement
bpy.ops.object.select_all(action='DESELECT')
for o in merged+special:o.select_set(True)
path=OUTPUT/(KIND+'.glb')
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_animations=False,export_lights=False,export_cameras=False)
meta['bytes']=path.stat().st_size
meta['mesh_objects']=len(bpy.context.selected_objects)
(OUTPUT/(KIND+'.json')).write_text(json.dumps(meta,indent=2))
# Export reusable species from the supplied village's metaball families, restricted to each plot.
if KIND=='village':
 depsgraph=bpy.context.evaluated_depsgraph_get()
 for species,plot in [('dog',0),('cat',1),('horse',2),('rabbit',3),('bird',4),('guinea',7),('turtle',9)]:
  root=roots[plot].matrix_world.translation
  parts=[]
  for name in ['sc_'+species]+(['mane'] if species=='horse' else []):
   original=scene.objects.get(name)
   if not original:continue
   evaluated=original.evaluated_get(depsgraph)
   mesh=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=depsgraph)
   vs=[original.matrix_world@v.co for v in mesh.vertices]
   indices={i for i,v in enumerate(vs) if abs(v.x-root.x)<1.4 and abs(v.y-root.y)<1.4}
   faces=[list(p.vertices) for p in mesh.polygons if all(i in indices for i in p.vertices)]
   used=sorted({i for f in faces for i in f});mapping={i:j for j,i in enumerate(used)}
   if not used:continue
   bottom=min(vs[i].z for i in used)
   data=bpy.data.meshes.new('sculpture_'+species)
   data.from_pydata([(vs[i].x-root.x,vs[i].y-root.y,vs[i].z-bottom) for i in used],[],[[mapping[i] for i in f] for f in faces]);data.update()
   obj=bpy.data.objects.new('sculpture_'+species,data);scene.collection.objects.link(obj)
   for mat in original.data.materials:data.materials.append(mat)
   for p in data.polygons:p.use_smooth=True
   parts.append(obj)
  assert parts,'No geometry extracted for '+species
  bpy.ops.object.select_all(action='DESELECT')
  for p in parts:p.select_set(True)
  bpy.context.view_layer.objects.active=parts[0]
  bpy.ops.export_scene.gltf(filepath=str(OUTPUT/('pet_'+species+'.glb')),export_format='GLB',use_selection=True,export_apply=True,export_animations=False,export_lights=False)
# Standalone sculpture scenes contain the two different dog shapes.
if KIND.startswith('sculpture_'):
 bpy.ops.object.select_all(action='DESELECT')
 dog=scene.objects.get('pet_sculpture');assert dog
 dog.select_set(True);bpy.context.view_layer.objects.active=dog
 dog.location=(0,0,0)
 bpy.ops.export_scene.gltf(filepath=str(OUTPUT/('pet_dog_'+KIND.removeprefix('sculpture_')+'.glb')),export_format='GLB',use_selection=True,export_apply=True,export_animations=False,export_lights=False)
result={'scene':KIND,'bytes':meta['bytes'],'meshes':meta['mesh_objects']}
