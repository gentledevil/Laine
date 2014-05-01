const Gio = imports.gi.Gio;
const Lang = imports.lang;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;
const Main = imports.ui.main;
const Slider = imports.ui.slider;

const WindowTracker = Shell.WindowTracker.get_default();
const Me = imports.misc.extensionUtils.getCurrentExtension();


const PA_MAX = 65536;
const WATCH_RULE = "type='signal'," +
		"sender='org.freedesktop.DBus'," +
		"interface='org.freedesktop.DBus'," +
		"member='NameOwnerChanged'," +
		"path='/org/freedesktop/DBus'," +
		"arg0namespace='org.mpris.MediaPlayer2'";

const StreamMenu = new Lang.Class({
	Name: 'StreamMenu',
	Extends: PopupMenu.PopupMenuSection,

	_init: function(paconn){
		this.parent();
		this._paDBus = paconn;

		this._mprisControl = new MPRISControl(this, this._paDBus);

		this._streams = {};
		this._delegatedStreams = {};
		this._streams.length = 0;

		//Add any existing streams
		this._paDBus.call(null, '/org/pulseaudio/core1', 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1', 'PlaybackStreams']), 
			GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, this._hdlAddStreams));

		//Add signal handlers
		this._sigNewStr = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1', 'NewPlaybackStream',
			'/org/pulseaudio/core1', null, Gio.DBusSignalFlags.NONE, Lang.bind(this, this._onAddStream), null );
		this._sigRemStr = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1', 'PlaybackStreamRemoved',
			'/org/pulseaudio/core1', null, Gio.DBusSignalFlags.NONE, Lang.bind(this, this._onRemoveStream), null );

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	_hdlAddStreams: function(conn, query){
		let response = conn.call_finish(query).get_child_value(0).unpack();
		for(let i = 0; i < response.n_children(); i++)
			this._addPAStream(response.get_child_value(i).get_string()[0]);
	},

	_addPAStream: function(path){
		this._paDBus.call(null, path, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'PropertyList']), 
			GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let streamInfo = conn.call_finish(query).get_child_value(0).unpack();

				//Decode stream information
				let sInfo = {};
				for(let i = 0; i < streamInfo.n_children(); i++){
					let [key, value] = streamInfo.get_child_value(i).unpack();
					let bytes = new Array();
					for(let j = 0; j < value.n_children(); j++)
						bytes[j] = value.get_child_value(j).get_byte();
					sInfo[key.get_string()[0]] = String.fromCharCode.apply(String, bytes);
				}

				let pID = parseInt(sInfo['application.process.id']);
				let role;
				if('media.role' in sInfo){
					role = sInfo['media.role'];
					role = role.substring(0, role.length -1);
				}

				if(role != 'event'){
					let mprisCheck = false;

					if(this._mprisControl){
						mprisCheck = this._mprisControl.isMPRISStream(pID, path);
					}

					if(mprisCheck){
						this._delegatedStreams[path] = this._mprisControl;
					} else {
						let stream = new SimpleStream(this._paDBus, path, sInfo);
						this._streams[path] = stream;
						this.addMenuItem(stream);
						this._streams.length ++;
					}


				}
			})
		);
	},

	_onAddStream: function(conn, sender, object, iface, signal, param, user_data){
		let streamPath = param.get_child_value(0).unpack();
		this._addPAStream(streamPath);
/*
		if(this._streams.length > 0)
			this.actor.show();*/
	},

	_onRemoveStream: function(conn, sender, object, iface, signal, param, user_data){
		
		let streamPath = param.get_child_value(0).unpack();
		
		if(streamPath in this._streams){

			this._streams[streamPath].destroy();
			delete this._streams[streamPath];
			this._streams.length --;
/*
			if(this._streams.length == 0)
				this.actor.hide();*/
		}
		else if(streamPath in this._delegatedStreams){
			this._delegatedStreams[streamPath].removePAStream(streamPath);
			delete this._delegatedStreams[streamPath];
		}
	},

	_onDestroy: function(){
		this._paDBus.signal_unsubscribe(this._sigNewStr);
		this._paDBus.signal_unsubscribe(this._sigRemStr);
	}
});


const StreamBase = new Lang.Class({
	Name: 'StreamBase',
	Extends: PopupMenu.PopupMenuSection,
	Abstract: true,

	_init: function(paconn){
		this.parent();
		this._paDBus = paconn;
		this._paPath = null;

		this._label = new St.Label({style_class: 'simple-stream-label', reactive: true})
		this._muteBtn = new St.Button();
		this._volSlider = new Slider.Slider(0);

		//------------------------------------------------------------------
		//Laying out components
		let container = new St.BoxLayout({vertical:true});
		container.add_actor(this._label);
		container.add_actor(this._volSlider.actor,{expand:true});

		this.actor.add_style_class_name('stream');
		this.actor.set_vertical(false);
		this.actor.set_track_hover(true);
		this.actor.set_reactive(true);

		this.actor.add(this._muteBtn);
		this.actor.add(container, {expand:true});

		//------------------------------------------------------------------
		
		this._muteBtn.connect('clicked', Lang.bind(this, function(){
			this.setVolume(!this._muteVal);
		}));

		this._volSlider.connect('value-changed', Lang.bind(this, function(slider, value, property){
			this.setVolume(value);
		}));

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	setPAPath: function(path){
		this._paPath = path;

		this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'Mute']), GLib.VariantType.new("(v)"), 
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let result = conn.call_finish(query);
				this.setVolume(result.get_child_value(0).unpack());
			}));

		this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Get',
			GLib.Variant.new('(ss)', ['org.PulseAudio.Core1.Stream', 'Volume']), GLib.VariantType.new("(v)"), 
			Gio.DBusCallFlags.NONE, -1, null, Lang.bind(this, function(conn, query){
				let result = conn.call_finish(query);
				this.setVolume(result.get_child_value(0).unpack());
			}));

		this._sigVol = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1.Stream', 'VolumeUpdated',
			this._paPath, null, Gio.DBusSignalFlags.NONE, Lang.bind(this, function(conn, sender, object, iface, signal, param, user_data){
				this.setVolume(param.get_child_value(0));
			}), null );
		this._sigMute = this._paDBus.signal_subscribe(null, 'org.PulseAudio.Core1.Stream', 'MuteUpdated',
			this._paPath, null, Gio.DBusSignalFlags.NONE, Lang.bind(this, function(conn, sender, object, iface, signal, param, user_data){
				this.setVolume(param.get_child_value(0));
			}), null );
	},

	setVolume: function(volume){
		if(typeof volume === 'boolean'){
			let val = GLib.Variant.new_boolean(volume);
			this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Set',
				GLib.Variant.new('(ssv)', ['org.PulseAudio.Core1.Stream', 'Mute', val]), null, 
				Gio.DBusCallFlags.NONE, -1, null, null);
		} 	
		else if(typeof volume === 'number'){
			if(volume > 1) volume = 1;
			let max = this._volVariant.get_child_value(0).get_uint32();
			for(let i = 1; i < this._volVariant.n_children(); i++){
				let val = this._volVariant.get_child_value(i).get_uint32();
				if(val > max) max = val;
			}

			let target = volume * PA_MAX;
			if(target != max){ //Otherwise no change
				let targets = new Array();
				for(let i = 0; i < this._volVariant.n_children(); i++){
					let newVal;
					if(max == 0)
						newVal = target;
					else { //To maintain any balance the user has set.
						let oldVal = this._volVariant.get_child_value(i).get_uint32();
						newVal = (oldVal/max)*target;
					}
					newVal = Math.round(newVal);
					targets[i] = GLib.Variant.new_uint32(newVal);
				}
				targets = GLib.Variant.new_array(null, targets);
				this._paDBus.call(null, this._paPath, 'org.freedesktop.DBus.Properties', 'Set',
					GLib.Variant.new('(ssv)', ['org.PulseAudio.Core1.Stream', 'Volume', targets]), null, 
					Gio.DBusCallFlags.NONE, -1, null, null);
			}
		}
		else if(volume instanceof GLib.Variant){
			let type = volume.get_type_string();
			if(type == 'au'){
				this._volVariant = volume;
				if(!this._muteVal){
					let maxVal = volume.get_child_value(0).get_uint32();
					for(let i = 1; i < volume.n_children(); i++){
						let val = volume.get_child_value(i).get_uint32();
						if(val > maxVal) maxVal = val;
					}

					this._volSlider.setValue(maxVal/PA_MAX);
				}
			}
			else if(type == 'b'){
				this._muteVal = volume.get_boolean();
				if(this._muteVal)
					this._volSlider.setValue(0);
				else if(this._volVariant)
					this.setVolume(this._volVariant);
			}
		}
	},

	_onDestroy: function(){
		if(this._paPath != null){
			this._paDBus.signal_unsubscribe(this._sigVol);
			this._paDBus.signal_unsubscribe(this._sigMute);
		}
	},

	_raise: function(){}

});

const SimpleStream = new Lang.Class({
	Name: 'SimpleStream',
	Extends: StreamBase,

	_init: function(paconn, path, sInfo){
		this.parent(paconn);
		this.setPAPath(path);

		this._procID = parseInt(sInfo['application.process.id']);

		this._app = WindowTracker.get_app_from_pid(this._procID);
		if(this._app == null){
			//Doesn't have an open window, lets check the tray.
			let trayNotifications = Main.messageTray.getSources();
			for(let i = 0; i < trayNotifications.length; i++)
				if(trayNotifications[i].pid == this._procID)
					this._app = trayNotifications[i].app;
		}

		let icon, name;
		if(this._app == null){
			name = sInfo['application.name'];
			let iname;
			if('application.icon_name' in sInfo) iname = sInfo['application.icon_name'];
			else iname = 'package_multimedia';
			icon = new St.Icon({icon_name: iname, style_class: 'simple-stream-icon'});
		} else {
			let info = this._app.get_app_info();
			name = info.get_name();
			icon = new St.Icon({style_class: 'simple-stream-icon'});
			icon.set_gicon(info.get_icon());
		}

		this._muteBtn.child = icon;
		this._label.text = name;

		this._label.connect('button-press-event', Lang.bind(this, function(){
			if(this._app != null)
				this._app.activate();
		}));
	}
});

const MPRISControl = new Lang.Class({
	Name: 'MPRISControl',

	_init: function(parent, paconn){
		this._parent = parent;
		this._paDBus = paconn
		this.actor = parent.actor;

		this._mprisStreams = {};
		this._mprisStreams.length = 0;

		this._dbus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
	//	this._dbus = Gio.DBusConnection.new_for_address_sync('unix:path=/tmp/socat-listen', Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT, null, null);
	//	this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "Hello", null, GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, -1, null);

		this._addMPRISStreams(this._dbus);

		this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "AddMatch",
			GLib.Variant.new('(s)', [WATCH_RULE]), null, Gio.DBusCallFlags.NONE, -1, null);
		this._sigNOC = this._dbus.signal_subscribe('org.freedesktop.DBus', "org.freedesktop.DBus", "NameOwnerChanged",
    		"/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NO_MATCH_RULE, Lang.bind(this, this._onConnChange));

		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
	},

	_addMPRISStreams: function(dbus){
		let connections = this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "ListNames",
			null, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, -1, null);
		connections = connections.get_child_value(0).unpack();

		for(let i = 0; i < connections.length; i++){
			let path = connections[i].get_string()[0];
			if(path.search('^org.mpris.MediaPlayer2') == -1)
				continue;

			let pid = this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetConnectionUnixProcessID",
				GLib.Variant.new('(s)', [path]), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, -1, null);
			pid = pid.get_child_value(0).get_uint32();

			if(!(pid in this._mprisStreams)) {
				let uName = this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetNameOwner",
					GLib.Variant.new('(s)', [path]), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, -1, null);
				uName = uName.get_child_value(0).unpack();

				let newStr = new MPRISStream(uName, pid, this._dbus, this._paDBus);
				this._mprisStreams[pid] = newStr;
				this.actor.add(newStr.actor);
				this._mprisStreams.length ++;
			}
		}
	},

	removePAStream:function(path){
		for(let pid in this._mprisStreams){
			if(this._mprisStreams[pid]._paPath == path){
				this._mprisStreams[pid].unsetPAStream();
				break;
			}
		}
	},

	isMPRISStream: function(pid, path){
		if(pid in this._mprisStreams){
			this._mprisStreams[pid].setPAStream(path);
			return true;
		}
		return false;
	},

	_onConnChange: function(conn, sender, object, iface, signal, param, user_data){
		let path = param.get_child_value(0).get_string()[0];
		let add = (param.get_child_value(1).get_string()[0] == '');

		if(path.search('^org.mpris.MediaPlayer2') != 0)
			return;

		if(add){
			let uName = param.get_child_value(2).get_string()[0];

			let pid = this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "GetConnectionUnixProcessID",
				GLib.Variant.new('(s)', [uName]), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, -1, null);
			pid = pid.get_child_value(0).get_uint32();

			if(!(pid in this._mprisStreams)){
				let newStr = new MPRISStream(uName, pid, this._dbus, this._paDBus);
				this._mprisStreams[pid] = newStr;
				this.actor.add(newStr.actor);
				this._mprisStreams.length ++;
			}
		}
		else {
			for(let k in this._mprisStreams){
				let uName = param.get_child_value(1).get_string()[0];
				if(k != 'length' && this._mprisStreams[k]._path == uName){
					this._mprisStreams[k].destroy();
					delete this._mprisStreams[k];
					break;
				}
			}
		}
	},

	_onDestroy: function(){
		this._dbus.signal_unsubscribe(this._sigNOC);
		this._dbus.call_sync('org.freedesktop.DBus', '/', "org.freedesktop.DBus", "RemoveMatch",
			GLib.Variant.new('(s)', [rule]), null, Gio.DBusCallFlags.NONE, -1, null);
	}

});

const MPRISStream = new Lang.Class({
	Name: 'MPRISStream',
	Extends: StreamBase,

	_init: function(dbusPath, pid, dbus, paconn){
		this.parent(paconn);
		this._path = dbusPath;
		this._procID = pid;
		this._dbus = dbus;
		log('A'+this.actor);
	}
};