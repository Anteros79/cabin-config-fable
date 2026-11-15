import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {RoundedBoxGeometry} from './vendor/RoundedBoxGeometry.js';

// Illustrative furniture; actual location membership comes from the dated demo layout.
export class CabinViewer {
  constructor(element,onSelect){
    this.element=element;this.onSelect=onSelect;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#10202b');
    this.camera=new THREE.PerspectiveCamera(40,element.clientWidth/element.clientHeight,.1,200);
    this.renderer=new THREE.WebGLRenderer({antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));this.renderer.setSize(element.clientWidth,element.clientHeight);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;element.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label','3D aircraft cabin cutaway');
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.minDistance=2;this.controls.maxDistance=75;this.controls.maxPolarAngle=Math.PI*.49;
    this.controls.addEventListener('change',()=>this.render());
    this.scene.add(new THREE.HemisphereLight(0xd6eeff,0x2b3c48,2.4));
    const sun=new THREE.DirectionalLight(0xfff3db,3);sun.position.set(-8,15,-9);this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0x80b5ff,1.5);fill.position.set(8,4,8);this.scene.add(fill);
    const grid=new THREE.GridHelper(100,100,0x28404f,0x1c303d);grid.position.y=-.25;this.scene.add(grid);
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.pickables=[];this.instanced=[];this.singles=[];
    this.selected=null;this.recorded=new Set();
    new ResizeObserver(()=>{const w=element.clientWidth,h=element.clientHeight;if(!w||!h)return;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);if(this.viewMode)this.setView(this.viewMode);else this.render();}).observe(element);
    this.renderer.domElement.addEventListener('pointerdown',e=>{this.down=[e.clientX,e.clientY];});
    this.renderer.domElement.addEventListener('pointerup',e=>{if(this.down&&Math.hypot(e.clientX-this.down[0],e.clientY-this.down[1])<5){const id=this.pick(e);if(id)this.onSelect(id);}});
    this.renderer.domElement.addEventListener('pointermove',e=>{const id=this.pick(e);element.style.cursor=id?'pointer':'grab';document.querySelector('#hover-location').textContent=id?this.label(id):'Select a seat, floor, or overhead bin';});
  }
  label(id){return /^\d/.test(id)?`Seat ${id}`:id.replaceAll('-',' ').replaceAll('_',' ');}
  material(color){return new THREE.MeshStandardMaterial({color,roughness:.72,metalness:.08});}
  build(snapshot){
    if(this.cabin){this.scene.remove(this.cabin);const geometries=new Set(),materials=new Set();this.cabin.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)materials.add(o.material);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());}
    this.pickables=[];this.instanced=[];this.singles=[];this.cabin=new THREE.Group();this.scene.add(this.cabin);
    this.layers={};for(const n of ['seats','bins','floor']){this.layers[n]=new THREE.Group();this.cabin.add(this.layers[n]);}
    const seats=snapshot?.configuration?.variant?.seats||[];if(!seats.length){this.render();return;}
    this.rows=Math.max(...seats.map(s=>s.row));this.length=this.rows*.83+1.5;
    const xs={A:-1.65,B:-1.08,C:-.51,D:.51,E:1.08,F:1.65},z=row=>(row-1)*.83-this.length/2+1,transform=new THREE.Object3D();
    const batches=[
      {size:[.49,.14,.47],offset:[0,.47,0],color:0x47728f,select:true},
      {size:[.48,.73,.12],offset:[0,.91,.20],color:0x4b7792,select:true,tilt:-.10},
      {size:[.32,.17,.055],offset:[0,1.18,.115],color:0x8aaec3,select:true},
      {size:[.065,.06,.51],offset:[-.26,.69,0],color:0x8a9ba6},
      {size:[.065,.06,.51],offset:[.26,.69,0],color:0x8a9ba6},
      {size:[.06,.40,.055],offset:[-.17,.24,.13],color:0x4b5c67},
      {size:[.06,.40,.055],offset:[.17,.24,-.13],color:0x4b5c67},
    ];
    for(const b of batches){
      const geo=b.select?new RoundedBoxGeometry(...b.size,2,.04):new THREE.BoxGeometry(...b.size);
      const mesh=new THREE.InstancedMesh(geo,this.material(b.color),seats.length);
      mesh.userData.locations=seats.map(s=>s.id);mesh.userData.baseColors=seats.map(s=>b.select&&s.zone==='ELR'?0x629bb4:b.color);
      seats.forEach((s,i)=>{transform.position.set(xs[s.letter]+b.offset[0],b.offset[1],z(s.row)+b.offset[2]);transform.rotation.set(b.tilt||0,0,0);transform.updateMatrix();mesh.setMatrixAt(i,transform.matrix);mesh.setColorAt(i,new THREE.Color(mesh.userData.baseColors[i]));});
      this.layers.seats.add(mesh);this.pickables.push(mesh);this.instanced.push(mesh);
    }
    const box=(size,pos,color,location,layer)=>{
      const geo=layer==='bins'?new RoundedBoxGeometry(...size,2,.06):new THREE.BoxGeometry(...size);
      const mesh=new THREE.Mesh(geo,this.material(color));mesh.position.set(...pos);mesh.userData={location,baseColor:color};this.layers[layer].add(mesh);
      if(location){this.pickables.push(mesh);this.singles.push(mesh);}return mesh;
    };
    box([4.25,.13,this.length],[0,-.09,0],0x506572,'FULL_CABIN','floor');
    box([.53,.022,this.length-.05],[0,-.012,0],0x8b8d7d,'FULL_CABIN','floor');
    box([4.2,.025,.75],[0,-.005,-this.length/2+.37],0x698d95,'FORWARD','floor');
    for(let r=1;r<=this.rows;r++)box([4.22,.012,.018],[0,.002,z(r)+.38],0x2c424f,null,'floor');
    for(const side of [-1,1]){
      box([.07,.18,this.length],[side*2.15,.02,0],0x9aadb6,null,'floor');
      for(let m=1;m<=Math.ceil(this.rows/3);m++){
        const id=`BIN-${side<0?'L':'R'}-${String(m).padStart(2,'0')}`,first=(m-1)*3+1,span=Math.min(3,this.rows-first+1)*.83-.05,center=z(first)+(span-.83)/2;
        box([.70,.42,span],[side*1.73,1.98,center],0x97b2bf,id,'bins');
        const door=box([.07,.32,span-.05],[side*1.36,1.94,center],0xc2d2d8,id,'bins');door.rotation.z=side*.25;
        box([.035,.035,.16],[side*1.30,1.85,center],0x496471,id,'bins');
      }
    }
    this.setView('overview');this.highlight(this.selected,this.recorded);
  }
  setView(view){
    this.viewMode=view;const length=this.length||26;
    if(view==='top'){this.camera.position.set(0,length*1.5,.01);this.controls.target.set(0,0,0);}
    else if(view==='aisle'){this.camera.position.set(0,1.6,-length/2-.8);this.controls.target.set(0,1.1,length/2);}
    else{const narrow=this.camera.aspect<1.1;this.camera.position.set(length*(narrow?.22:.58),length*(narrow?.85:.65),-length*(narrow?1.12:.68));this.controls.target.set(0,.3,0);}
    this.controls.update();this.render();
  }
  showLayer(name,visible){if(this.layers?.[name]){this.layers[name].visible=visible;this.render();}}
  pick(event){
    const r=this.renderer.domElement.getBoundingClientRect();this.pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);
    const hit=this.raycaster.intersectObjects(this.pickables.filter(o=>o.parent.visible),false)[0];return hit?hit.object.userData.locations?.[hit.instanceId]||hit.object.userData.location:null;
  }
  highlight(selected,recorded){
    this.selected=selected;this.recorded=recorded;const color=(id,base)=>id===selected?0xb6f5d9:recorded.has(id)?0x4abf9d:base;
    this.instanced.forEach(m=>{m.userData.locations.forEach((id,i)=>m.setColorAt(i,new THREE.Color(color(id,m.userData.baseColors[i]))));m.instanceColor.needsUpdate=true;});
    this.singles.forEach(m=>m.material.color.setHex(color(m.userData.location,m.userData.baseColor)));this.render();
  }
  focus(location){
    this.viewMode=null;const batch=this.instanced[0],i=batch?.userData.locations.indexOf(location),v=new THREE.Vector3();
    if(i!==undefined&&i>=0){const m=new THREE.Matrix4();batch.getMatrixAt(i,m);v.setFromMatrixPosition(m);}else{const mesh=this.singles.find(m=>m.userData.location===location);if(!mesh)return;v.copy(mesh.position);}
    this.controls.target.copy(v);this.camera.position.copy(v).add(new THREE.Vector3(4,3.5,-4.5));this.controls.update();this.render();
  }
  screenPoint(location){const mesh=this.instanced[0],i=mesh?.userData.locations.indexOf(location);if(i===undefined||i<0)return null;const m=new THREE.Matrix4();mesh.getMatrixAt(i,m);const v=new THREE.Vector3().setFromMatrixPosition(m).project(this.camera),r=this.renderer.domElement.getBoundingClientRect();return{x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};}
  render(){this.renderer.render(this.scene,this.camera);}
}
