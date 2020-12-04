const { app } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const { getRandomString } = require(path.join(app.getAppPath(), 'app/utils/utils'));

class ChildProcessPool {
  constructor({ path, max=6, cwd, env }) {
    this.cwd = cwd || process.cwd();
    this.env = env || process.env;
    this.inspectStartIndex = 5858;
    this.callbacks = {};
    this.pidMap = new Map();
    this.collaborationMap = new Map();
    this.forked = [];
    this.forkedPath = path;
    this.forkIndex = 0;
    this.forkMaxIndex = max;
  }
  
  /* Received data from a child process */
  dataRespond = (data, id) => {
    if (id && this.callbacks[id]) {
      this.callbacks[id](data);
      delete this.callbacks[id];
    };
  }

  /* Received data from multi child processes */
  dataRespondAll = (data, id) => {
    if (!id) return;
    let resultAll = this.collaborationMap.get(id);
    if (resultAll !== undefined) {
      this.collaborationMap.set(id, [...resultAll, data]);
    } else {
      this.collaborationMap.set(id, [data]);
    }
    resultAll = this.collaborationMap.get(id);
    if (resultAll.length === this.forked.length) {
      this.callbacks[id](resultAll);
      delete this.callbacks[id];
      this.collaborationMap.delete(id);
    }
  }

  /* Get a process instance from the pool */
  getForkedFromPool(id="default") {
    let forked;
    if (!this.pidMap.get(id)) {
      // create new process
      if (this.forked.length < this.forkMaxIndex) {
        this.inspectStartIndex ++;
        forked = fork(
          this.forkedPath,
          this.env.NODE_ENV === "development" ? [`--inspect=${this.inspectStartIndex}`] : [],
          {
            cwd: this.cwd,
            env: { ...this.env, id },
          }
        );
        this.forked.push(forked);
        forked.on('message', (data) => {
          const id = data.id;
          delete data.id;
          delete data.action;
          this.onMessage({ data, id });
        });
      } else {
        this.forkIndex = this.forkIndex % this.forkMaxIndex;
        forked = this.forked[this.forkIndex];
      }
      
      if(id !== 'default')
        this.pidMap.set(id, forked.pid);
      if(this.pidMap.values.length === 1000)
        console.warn('ChildProcessPool: The count of pidMap is over than 1000, suggest to use unique id!');
        
      this.forkIndex += 1;
    } else {
      // use existing processes
      forked = this.forked.filter(f => f.pid === this.pidMap.get(id))[0];
      if (!forked) throw new Error(`Get forked process from pool failed! the process pid: ${this.pidMap.get(id)}.`);
    }

    return forked;
  }

  /**
    * onMessage [Received data from a process]
    * @param  {[Any]} data [response data]
    * @param  {[String]} id [process tmp id]
    */
  onMessage({ data, id }) {
    if (this.collaborationMap.get(id) !== undefined) {
      this.dataRespondAll(data, id)
    } else {
      this.dataRespond(data, id);
    }
  }

  /* Send request to a process */
  send(taskName, params, givenId) {
    if (givenId === 'default') throw new Error('ChildProcessPool: Prohibit the use of this id value: [default] !')

    const id = getRandomString();
    const forked = this.getForkedFromPool(givenId);
    return new Promise(resolve => {
      this.callbacks[id] = resolve;
      forked.send({action: taskName, params, id });
    });
  }

  /* Send requests to all processes */
  sendToAll(taskName, params) {
    const id = getRandomString(); 
    return new Promise(resolve => {
      this.callbacks[id] = resolve;
      this.collaborationMap.set(id, []);
      if (this.forked.length) {
        // use process in pool
        this.forked.forEach((forked) => {
          forked.send({ action: taskName, params, id });
        })
      } else {
        // use default process
        this.getForkedFromPool().send({ action: taskName, params, id });
      }
    });
  }
}

module.exports = ChildProcessPool;